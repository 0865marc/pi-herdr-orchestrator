import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig, PACKAGE_ROOT, writerArgs } from "./config.mjs";
import { createDetachedWorktree, gitSnapshot } from "./git.mjs";
import { agentGet, agentPrompt, agentRead, agentWait, closePane, renamePane, splitPane, startPiAgent } from "./herdr.mjs";
import { createRunId, writerAgentName } from "./naming.mjs";
import { runChecked } from "./process.mjs";
import { readState, resolveRunId, updateState, writeState, writerWavePathFor } from "./state.mjs";

const ACTIVE_WAVE_STATES = new Set(["preparing", "running", "settled", "capturing", "validated", "integrating"]);
const SETTLED_AGENT_STATES = new Set(["idle", "done"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

function laneIsTerminal(lane) {
  return Boolean(lane.abortedAt || lane.frozenAt || (lane.startedAt && SETTLED_AGENT_STATES.has(lane.liveStatus)));
}

function now() {
  return new Date().toISOString();
}

function posixPath(value) {
  return value.split(path.sep).join("/");
}

function gitEnvironment(indexPath) {
  return {
    ...(indexPath ? { GIT_INDEX_FILE: indexPath } : {}),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
  };
}

async function git(cwd, args, options = {}) {
  return runChecked("git", ["-C", cwd, ...args], options);
}

function normalizeWritePath(value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || path.posix.isAbsolute(value)) {
    throw new Error(`Unsafe writer write_set path: ${String(value)}`);
  }
  const raw = value.replaceAll("\\", "/");
  if (/[\u0000-\u001f\u007f]/u.test(raw)) throw new Error(`Writer write_set cannot contain control characters: ${value}`);
  if (/[*?[\]{}]/u.test(raw)) throw new Error(`Writer write_set does not support globs: ${value}`);
  const directory = raw.endsWith("/");
  const normalized = path.posix.normalize(raw).replace(/^\.\//u, "").replace(/\/$/u, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Unsafe writer write_set path: ${value}`);
  }
  if (normalized.split("/").some((segment) => segment.toLowerCase() === ".git")) {
    throw new Error(`Writer write_set cannot include Git administrative paths: ${value}`);
  }
  return `${normalized}${directory ? "/" : ""}`;
}

function writePathCovers(pattern, relative) {
  const target = posixPath(relative);
  return pattern.endsWith("/") ? target.startsWith(pattern) : target === pattern;
}

function writePathsOverlap(left, right) {
  const foldedLeft = left.normalize("NFC").toLowerCase();
  const foldedRight = right.normalize("NFC").toLowerCase();
  const leftBase = foldedLeft.replace(/\/$/u, "");
  const rightBase = foldedRight.replace(/\/$/u, "");
  return foldedLeft === foldedRight
    || (foldedLeft.endsWith("/") && (rightBase === leftBase || foldedRight.startsWith(foldedLeft)))
    || (foldedRight.endsWith("/") && (leftBase === rightBase || foldedLeft.startsWith(foldedRight)));
}

export function normalizeWriterLanes(lanes, maxLanes = 3) {
  if (!Array.isArray(lanes) || lanes.length === 0) throw new Error("At least one writer lane is required.");
  if (lanes.length > maxLanes) throw new Error(`Writer wave exceeds the configured limit of ${maxLanes} lanes.`);
  const ids = new Set();
  const normalized = lanes.map((lane, index) => {
    if (!lane || typeof lane !== "object") throw new Error(`Writer lane ${index + 1} must be an object.`);
    const id = String(lane.id ?? "").trim();
    if (!SAFE_ID.test(id)) throw new Error(`Invalid writer lane id: ${id || "missing"}`);
    if (ids.has(id)) throw new Error(`Duplicate writer lane id: ${id}`);
    ids.add(id);
    const label = String(lane.label ?? "").trim();
    const scope = String(lane.scope ?? "").trim();
    const task = String(lane.task ?? "").trim();
    const acceptance = String(lane.acceptance ?? "").trim();
    if (!label || label.length > 48 || /[\u0000-\u001f\u007f]/u.test(label) || !scope || !task || !acceptance) {
      throw new Error(`Writer lane '${id}' requires label (max 48), scope, task, and acceptance.`);
    }
    if (Array.isArray(lane.depends_on) && lane.depends_on.length > 0) {
      throw new Error(`Writer lane '${id}' has dependencies and cannot join this parallel wave.`);
    }
    if (!Array.isArray(lane.write_set)) throw new Error(`Writer lane '${id}' requires write_set as an array.`);
    const writeSet = [...new Set(lane.write_set.map(normalizeWritePath))].sort();
    if (writeSet.length === 0) throw new Error(`Writer lane '${id}' requires a non-empty write_set.`);
    for (let left = 0; left < writeSet.length; left += 1) {
      for (let right = left + 1; right < writeSet.length; right += 1) {
        if (writePathsOverlap(writeSet[left], writeSet[right])) {
          throw new Error(`Writer lane '${id}' contains overlapping write_set entries: ${writeSet[left]} and ${writeSet[right]}`);
        }
      }
    }
    return { id, label, scope, task, acceptance, writeSet, dependsOn: [] };
  });

  for (let left = 0; left < normalized.length; left += 1) {
    for (let right = left + 1; right < normalized.length; right += 1) {
      for (const leftPath of normalized[left].writeSet) {
        for (const rightPath of normalized[right].writeSet) {
          if (writePathsOverlap(leftPath, rightPath)) {
            throw new Error(`Writer lanes '${normalized[left].id}' and '${normalized[right].id}' overlap at ${leftPath} / ${rightPath}.`);
          }
        }
      }
    }
  }
  return normalized;
}

export function currentWriterWave(state) {
  const waves = state.parallelImplementation?.waves ?? [];
  return waves.at(-1) ?? null;
}

export function writerWaveIsActive(state) {
  const wave = currentWriterWave(state);
  return Boolean(wave && ACTIVE_WAVE_STATES.has(wave.status));
}

export function writerWaveBlocksReview(state) {
  const wave = currentWriterWave(state);
  return Boolean(wave && !["integrated", "reconciled", "abandoned"].includes(wave.status));
}

export function assertBuilderWriterAuthority(state, env = process.env, cwd = process.cwd()) {
  if (env.PI_HERDR_ORCHESTRATOR_ROLE !== "builder" || env.PI_HERDR_ORCHESTRATOR_RUN_ID !== state.id) {
    throw new Error("Only the owning top-level Builder may control writer waves.");
  }
  const builder = state.roles?.builder;
  if (!builder?.cwd || path.resolve(builder.cwd) !== path.resolve(cwd) || path.resolve(env.PI_HERDR_ORCHESTRATOR_ROLE_ROOT ?? "") !== path.resolve(cwd)) {
    throw new Error("Builder writer authority does not match the registered Builder worktree.");
  }
  if (!builder?.paneId || !env.HERDR_PANE_ID || builder.paneId !== env.HERDR_PANE_ID) {
    throw new Error("Builder writer authority does not match the registered Herdr pane.");
  }
  if (!builder.workspaceId || !env.HERDR_WORKSPACE_ID || builder.workspaceId !== env.HERDR_WORKSPACE_ID) {
    throw new Error("Builder writer authority does not match the registered Herdr workspace.");
  }
}

async function baseTree(cwd, base, options = {}) {
  const result = await git(cwd, ["ls-tree", "-r", "-z", "--full-tree", base], options);
  const entries = new Map();
  for (const record of result.stdout.split("\0").filter(Boolean)) {
    const match = /^(\d+) ([^ ]+) ([0-9a-f]+)\t([\s\S]+)$/u.exec(record);
    if (!match) throw new Error("Could not parse Git tree entry for writer capture.");
    entries.set(posixPath(match[4]), { mode: match[1], type: match[2], oid: match[3] });
  }
  return entries;
}

async function ensureNoGitlinks(cwd, base, options = {}) {
  const entries = await baseTree(cwd, base, options);
  const gitlink = [...entries].find(([, entry]) => entry.mode === "160000" || entry.type === "commit");
  if (gitlink) throw new Error(`Writer waves do not support repositories with Git links/submodules yet: ${gitlink[0]}`);
}

async function scanWorktree(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const output = new Map();
  for (const entry of entries) {
    if (!relative && entry.name === ".git") continue;
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    const childPath = path.join(root, childRelative);
    const stat = await lstat(childPath);
    const key = posixPath(childRelative);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      const nested = await scanWorktree(root, childRelative);
      for (const [nestedKey, nestedValue] of nested) output.set(nestedKey, nestedValue);
    } else if (stat.isSymbolicLink()) {
      output.set(key, { kind: "symlink", mode: "120000", target: await readlink(childPath) });
    } else if (stat.isFile()) {
      output.set(key, { kind: "file", mode: stat.mode & 0o111 ? "100755" : "100644", path: childPath });
    } else {
      throw new Error(`Writer produced unsupported filesystem entry: ${key}`);
    }
  }
  return output;
}

async function hashEntry(cwd, entry, write, options = {}) {
  const args = ["hash-object", ...(write ? ["-w"] : []), "--no-filters"];
  if (entry.kind === "symlink") {
    const result = await git(cwd, [...args, "--stdin"], { ...options, input: entry.target });
    return result.stdout.trim();
  }
  const result = await git(cwd, [...args, entry.path], options);
  return result.stdout.trim();
}

async function entryDigest(entry) {
  const hash = createHash("sha256");
  if (entry.kind === "symlink") hash.update(entry.target);
  else hash.update(await readFile(entry.path));
  return hash.digest("hex");
}

async function writeRawTree({ worktree, entries, indexPath, signal }) {
  const indexEnv = gitEnvironment(indexPath);
  await git(worktree, ["read-tree", "--empty"], { signal, env: indexEnv });
  for (const [relative, entry] of entries) {
    const oid = await hashEntry(worktree, entry, true, { signal, env: indexEnv });
    await git(worktree, ["update-index", "--add", "--cacheinfo", `${entry.mode},${oid},${relative}`], { signal, env: indexEnv });
  }
  return (await git(worktree, ["write-tree"], { signal, env: indexEnv })).stdout.trim();
}

export async function captureWriterBaseline({ worktree, indexPath, signal }) {
  const entries = await scanWorktree(worktree);
  await mkdir(path.dirname(indexPath), { recursive: true, mode: 0o700 });
  const tree = await writeRawTree({ worktree, entries, indexPath, signal });
  return { tree, fileCount: entries.size, capturedAt: now() };
}

export async function captureWriterDelta({ worktree, base, baselineTree, writeSet, patchPath, maxFiles, maxPatchBytes, signal }) {
  const options = { signal, env: gitEnvironment() };
  const comparisonTree = baselineTree || base;
  if (!comparisonTree) throw new Error("Writer capture requires a raw baseline tree or Git base.");
  const baseEntries = await baseTree(worktree, comparisonTree, options);
  const workingEntries = await scanWorktree(worktree);
  const changed = [];
  for (const [relative, entry] of workingEntries) {
    const previous = baseEntries.get(relative);
    const oid = await hashEntry(worktree, entry, false, options);
    if (!previous || previous.oid !== oid || previous.mode !== entry.mode) {
      changed.push({ path: relative, kind: previous ? "modified" : "added", mode: entry.mode, oid, entry });
    }
  }
  for (const relative of baseEntries.keys()) {
    if (!workingEntries.has(relative)) changed.push({ path: relative, kind: "deleted" });
  }
  changed.sort((left, right) => left.path.localeCompare(right.path));
  if (changed.length > maxFiles) throw new Error(`Writer lane changed ${changed.length} paths; configured limit is ${maxFiles}.`);
  const outside = changed.find((entry) => !writeSet.some((allowed) => writePathCovers(allowed, entry.path)));
  if (outside) throw new Error(`Writer changed '${outside.path}' outside its declared write_set.`);

  const indexPath = `${patchPath}.index`;
  await mkdir(path.dirname(patchPath), { recursive: true, mode: 0o700 });
  const indexEnv = gitEnvironment(indexPath);
  await git(worktree, ["read-tree", comparisonTree], { signal, env: indexEnv });
  const manifest = [];
  for (const entry of changed) {
    if (entry.kind === "deleted") {
      await git(worktree, ["update-index", "--force-remove", "--", entry.path], { signal, env: indexEnv });
      manifest.push({ path: entry.path, kind: entry.kind });
      continue;
    }
    const oid = await hashEntry(worktree, entry.entry, true, { signal, env: indexEnv });
    await git(worktree, ["update-index", "--add", "--cacheinfo", `${entry.mode},${oid},${entry.path}`], { signal, env: indexEnv });
    manifest.push({ path: entry.path, kind: entry.kind, mode: entry.mode, digest: await entryDigest(entry.entry) });
  }
  const diff = await git(worktree, [
    "diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames", comparisonTree, "--",
  ], { signal, env: indexEnv, outputLimit: maxPatchBytes + 1 });
  if (Buffer.byteLength(diff.stdout, "utf8") > maxPatchBytes) {
    throw new Error(`Writer patch exceeds configured limit of ${maxPatchBytes} bytes.`);
  }
  await writeFile(patchPath, diff.stdout, { mode: 0o600 });
  await chmod(patchPath, 0o600);
  return {
    path: patchPath,
    digest: createHash("sha256").update(diff.stdout).digest("hex"),
    bytes: Buffer.byteLength(diff.stdout, "utf8"),
    changedPaths: changed.map((entry) => entry.path),
    entries: manifest,
  };
}

function writerPrompt(lane) {
  return [
    `Writer lane: ${lane.id}`,
    `Display label: ${lane.label}`,
    "",
    `Exact scope: ${lane.scope}`,
    "",
    "Permitted write_set (authoritative):",
    ...lane.writeSet.map((entry) => `- ${entry}`),
    "",
    `Implementation task: ${lane.task}`,
    "",
    `Acceptance criteria: ${lane.acceptance}`,
    "",
    "Implement only this lane. Do not wait for or reason about sibling lanes; the Builder reconciles their combined result.",
  ].join("\n");
}

function writerEnvironment(state, wave, lane, root) {
  return {
    PI_HERDR_ORCHESTRATOR_RUN_ID: state.id,
    PI_HERDR_ORCHESTRATOR_ROLE: "writer",
    PI_HERDR_ORCHESTRATOR_REPO_ROOT: state.repository.root,
    PI_HERDR_ORCHESTRATOR_ROLE_ROOT: lane.worktreePath,
    PI_HERDR_ORCHESTRATOR_PACKAGE_ROOT: root,
    PI_HERDR_ORCHESTRATOR_WRITER_WAVE_ID: wave.id,
    PI_HERDR_ORCHESTRATOR_WRITER_LANE_ID: lane.id,
  };
}

async function loadOwnedBuilder({ runId, cwd, env, stateOptions }) {
  const id = resolveRunId(runId, env);
  const state = await readState(id, stateOptions);
  assertBuilderWriterAuthority(state, env, cwd);
  return state;
}

export async function launchWriterWave({ runId, lanes, cwd = process.cwd(), root = PACKAGE_ROOT, env = process.env, signal, stateOptions = {} } = {}) {
  let state = await loadOwnedBuilder({ runId, cwd, env, stateOptions });
  if (writerWaveIsActive(state) || writerWaveBlocksReview(state)) {
    throw new Error(`Writer wave '${currentWriterWave(state)?.id}' must reach a terminal state before another wave starts.`);
  }
  const config = await loadConfig(root, env);
  const normalized = normalizeWriterLanes(lanes, config.policy.maxWriterPanesPerWave ?? 3);
  const snapshot = await gitSnapshot(cwd, { signal });
  if (!snapshot.clean) throw new Error("Parallel writer waves are available only before the Builder's first mutation; use sequential reconciliation for dirty correction rounds.");
  await ensureNoGitlinks(cwd, snapshot.head, { signal, env: gitEnvironment() });

  const waveId = createRunId();
  const waveRoot = writerWavePathFor({ runId: state.id, waveId }, { env: stateOptions.env, home: stateOptions.home });
  await mkdir(waveRoot, { recursive: true, mode: 0o700 });
  const wave = {
    id: waveId,
    status: "preparing",
    root: waveRoot,
    base: { head: snapshot.head, branch: snapshot.branch },
    createdAt: now(),
    lanes: normalized.map((lane) => ({
      ...lane,
      status: "planned",
      worktreePath: path.join(waveRoot, "worktrees", lane.id),
      sessionDir: path.join(waveRoot, "sessions", lane.id),
      agentName: writerAgentName(state.project, state.id, `${waveId}:${lane.id}`),
      workspaceId: state.roles.builder.workspaceId,
    })),
  };
  state = await updateState(state.id, (fresh) => {
    assertBuilderWriterAuthority(fresh, env, cwd);
    if (fresh.roles.orchestrator?.status !== "running") {
      throw new Error("Writer waves cannot start while the Orchestrator is finishing or inactive.");
    }
    if (fresh.roles.builder?.status !== "running") {
      throw new Error("Writer waves require an active Builder.");
    }
    if (fresh.roles.reviewer && fresh.roles.reviewer.status !== "closed") {
      throw new Error("Writer waves cannot start after Reviewer preparation has begun.");
    }
    if (writerWaveIsActive(fresh) || writerWaveBlocksReview(fresh)) {
      throw new Error(`Writer wave '${currentWriterWave(fresh)?.id}' must reach a terminal state before another wave starts.`);
    }
    fresh.parallelImplementation ??= { waves: [] };
    fresh.parallelImplementation.waves ??= [];
    fresh.parallelImplementation.waves.push(wave);
    return fresh;
  }, stateOptions);

  try {
    for (const lane of wave.lanes) {
      await mkdir(path.dirname(lane.worktreePath), { recursive: true, mode: 0o700 });
      await createDetachedWorktree({ root: cwd, base: snapshot.head, worktreePath: lane.worktreePath }, { signal });
      lane.baseline = await captureWriterBaseline({
        worktree: lane.worktreePath,
        indexPath: path.join(waveRoot, "baselines", `${lane.id}.index`),
        signal,
      });
      lane.status = "worktree_ready";
      lane.worktreeCreatedAt = now();
      await writeState(state, stateOptions);

      const split = await splitPane({
        paneId: state.roles.builder.paneId,
        cwd: lane.worktreePath,
        env: writerEnvironment(state, wave, lane, root),
        focus: false,
      }, { signal, env });
      lane.paneId = split.paneId;
      lane.status = "pane_ready";
      lane.paneCreatedAt = now();
      await renamePane(lane.paneId, `subagent · ${lane.label}`, { signal, env });
      await writeState(state, stateOptions);

      await mkdir(lane.sessionDir, { recursive: true, mode: 0o700 });
      await startPiAgent({
        name: lane.agentName,
        paneId: lane.paneId,
        args: writerArgs({ agentName: lane.agentName, root, config, sessionDir: lane.sessionDir }),
        timeoutMs: config.agentStartTimeoutMs,
      }, { signal, env });
      lane.status = "running";
      lane.startedAt = now();
      await writeState(state, stateOptions);
      await agentPrompt(lane.agentName, writerPrompt(lane), { wait: false, signal, env });
      lane.promptedAt = now();
      await writeState(state, stateOptions);
    }
    wave.status = "running";
    wave.startedAt = now();
    await writeState(state, stateOptions);
    return { ok: true, runId: state.id, waveId, status: wave.status, lanes: wave.lanes.map(({ id, label, paneId, agentName, worktreePath }) => ({ id, label, paneId, agentName, worktreePath })) };
  } catch (error) {
    wave.status = "needs_reconciliation";
    wave.error = error instanceof Error ? error.message : String(error);
    wave.failedAt = now();
    await writeState(state, stateOptions);
    throw error;
  }
}

async function refreshWaveStatus(state, wave, { env, signal, stateOptions }) {
  for (const lane of wave.lanes) {
    if (!lane.agentName) continue;
    try {
      const response = await agentGet(lane.agentName, { env, signal });
      lane.liveStatus = response?.result?.agent?.agent_status ?? "unknown";
      lane.lastObservedAt = now();
    } catch (error) {
      lane.liveStatus = "missing";
      lane.liveError = error instanceof Error ? error.message : String(error);
    }
  }
  if (["preparing", "running", "settled"].includes(wave.status)
    && wave.lanes.every((lane) => lane.startedAt && SETTLED_AGENT_STATES.has(lane.liveStatus))) {
    wave.status = "settled";
    wave.settledAt ??= now();
  } else if (wave.status === "settled") {
    wave.status = "running";
    delete wave.settledAt;
  }
  await writeState(state, stateOptions);
  return wave;
}

export async function statusWriterWave({ runId, cwd = process.cwd(), env = process.env, signal, stateOptions = {} } = {}) {
  const state = await loadOwnedBuilder({ runId, cwd, env, stateOptions });
  const wave = currentWriterWave(state);
  if (!wave) return { ok: true, wave: null };
  await refreshWaveStatus(state, wave, { env, signal, stateOptions });
  if (wave.status === "preparing" && wave.lanes.some((lane) => !lane.startedAt)) {
    wave.status = "needs_reconciliation";
    wave.error = "Writer launch was interrupted before every planned lane started.";
    wave.failedAt = now();
    await writeState(state, stateOptions);
  }
  return { ok: true, wave };
}

export async function waitWriterWave({ runId, timeoutMs = 1_200_000, cwd = process.cwd(), env = process.env, signal, stateOptions = {} } = {}) {
  const state = await loadOwnedBuilder({ runId, cwd, env, stateOptions });
  const wave = currentWriterWave(state);
  if (!wave || !["preparing", "running", "settled", "needs_reconciliation"].includes(wave.status)) throw new Error("There is no running writer wave to wait for.");
  await Promise.all(wave.lanes.filter((lane) => lane.startedAt).map(async (lane) => {
    try {
      await agentWait(lane.agentName, timeoutMs, { env, signal });
    } catch (error) {
      lane.waitError = error instanceof Error ? error.message : String(error);
    }
  }));
  await refreshWaveStatus(state, wave, { env, signal, stateOptions });
  if (wave.status === "preparing" && wave.lanes.some((lane) => !lane.startedAt)) {
    wave.status = "needs_reconciliation";
    wave.error = "Writer launch was interrupted before every planned lane started.";
    wave.failedAt = now();
    await writeState(state, stateOptions);
  }
  const settled = wave.lanes.every(laneIsTerminal);
  return { ok: settled, waveId: wave.id, status: wave.status, lanes: wave.lanes.map(({ id, label, liveStatus, waitError }) => ({ id, label, liveStatus, ...(waitError ? { waitError } : {}) })) };
}

export async function readWriterLane({ runId, laneId, lines = 160, cwd = process.cwd(), env = process.env, signal, stateOptions = {} } = {}) {
  const state = await loadOwnedBuilder({ runId, cwd, env, stateOptions });
  const wave = currentWriterWave(state);
  const lane = wave?.lanes?.find((candidate) => candidate.id === laneId);
  if (!lane?.agentName) throw new Error(`Unknown writer lane: ${laneId}`);
  return agentRead(lane.agentName, lines, { env, signal });
}

export async function abortWriterWave({ runId, reason, cwd = process.cwd(), env = process.env, signal, stateOptions = {} } = {}) {
  const state = await loadOwnedBuilder({ runId, cwd, env, stateOptions });
  const wave = currentWriterWave(state);
  if (!wave || ["integrated", "reconciled", "abandoned"].includes(wave.status)) throw new Error("There is no non-terminal Writer wave to abort.");
  if (typeof reason !== "string" || !reason.trim()) throw new Error("Aborting a Writer wave requires a concrete reason.");
  for (const lane of wave.lanes) {
    if (lane.paneClosedAt) continue;
    try {
      const closed = await closeLiveWriter(lane, { signal, env });
      if (closed.missing) lane.paneAlreadyMissing = true;
      if (closed.moved) lane.resolvedPaneId = closed.paneId;
      lane.paneClosedAt = now();
      lane.abortedAt = lane.paneClosedAt;
      lane.liveStatus = closed.missing ? "missing" : "aborted";
    } catch (error) {
      lane.abortError = error instanceof Error ? error.message : String(error);
    }
  }
  wave.status = "needs_reconciliation";
  wave.abortReason = reason.trim();
  wave.abortedAt = now();
  wave.error = `Writer wave aborted: ${wave.abortReason}`;
  await writeState(state, stateOptions);
  return { ok: true, waveId: wave.id, status: wave.status, reason: wave.abortReason, lanes: wave.lanes.map(({ id, abortedAt, abortError }) => ({ id, ...(abortedAt ? { abortedAt } : {}), ...(abortError ? { abortError } : {}) })) };
}

function herdrTargetMissing(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|unknown|does not exist|no .* found|missing/iu.test(message);
}

async function closeLiveWriter(lane, { env, signal }) {
  if (!lane.agentName) throw new Error(`Writer lane '${lane.id}' has no controller-owned agent identity.`);
  let response;
  try {
    response = await agentGet(lane.agentName, { signal, env });
  } catch (error) {
    if (herdrTargetMissing(error)) return { missing: true };
    throw error;
  }
  const live = response?.result?.agent;
  if (!live) return { missing: true };
  if (live.name && live.name !== lane.agentName) throw new Error(`Writer lane '${lane.id}' resolved to an unexpected agent identity.`);
  const paneId = live.pane_id;
  if (!paneId) throw new Error(`Writer lane '${lane.id}' has a live agent without a pane identity.`);
  await closePane(paneId, { signal, env });
  return { paneId, moved: Boolean(lane.paneId && lane.paneId !== paneId) };
}

async function freezeWriterLane(lane, { env, signal }) {
  try {
    const closed = await closeLiveWriter(lane, { env, signal });
    if (closed.missing) lane.paneAlreadyMissing = true;
    if (closed.moved) lane.resolvedPaneId = closed.paneId;
    lane.paneClosedAt = now();
    lane.frozenAt = lane.paneClosedAt;
    lane.liveStatus = closed.missing ? "missing" : "frozen";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not freeze Writer lane '${lane.id}': ${message}`, { cause: error });
  }
}

async function verifyPatch(patch, waveRoot) {
  const resolved = path.resolve(patch.path);
  const relative = path.relative(path.resolve(waveRoot), resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Writer patch is outside the controller-owned wave root.");
  const stat = await lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Writer patch is not a regular file: ${resolved}`);
  const content = await readFile(resolved);
  const digest = createHash("sha256").update(content).digest("hex");
  if (digest !== patch.digest) throw new Error(`Writer patch integrity check failed: ${resolved}`);
  return { path: resolved, content };
}

function concatenatePatches(patches) {
  return Buffer.concat(patches.flatMap((patch) => [patch.content, Buffer.from("\n")]));
}

export async function integrateWriterWave({ runId, cwd = process.cwd(), env = process.env, signal, stateOptions = {} } = {}) {
  const state = await loadOwnedBuilder({ runId, cwd, env, stateOptions });
  const config = await loadConfig(process.env.PI_HERDR_ORCHESTRATOR_PACKAGE_ROOT || PACKAGE_ROOT, env);
  const wave = currentWriterWave(state);
  if (!wave || !["running", "settled", "capturing", "validated", "integrating"].includes(wave.status)) throw new Error("Writer wave is not ready for integration.");
  if (["capturing", "validated", "integrating"].includes(wave.status)) {
    wave.status = "needs_reconciliation";
    wave.error = "A previous integration attempt was interrupted after capture; automatic replay was refused to avoid duplicate or partial application.";
    wave.failedAt = now();
    await writeState(state, stateOptions);
    throw new Error(wave.error);
  }
  await refreshWaveStatus(state, wave, { env, signal, stateOptions });
  if (wave.status !== "settled") throw new Error("Every writer must be idle or done before integration.");

  try {
    const before = await gitSnapshot(cwd, { signal });
    if (!before.clean || before.head !== wave.base.head || before.branch !== wave.base.branch) {
      throw new Error("Builder branch, HEAD, or worktree changed while writers were active; automatic integration refused.");
    }
    wave.status = "capturing";
    wave.captureStartedAt = now();
    await writeState(state, stateOptions);
    for (const lane of wave.lanes) {
      try {
        lane.report = await agentRead(lane.agentName, 80, { env, signal });
      } catch (error) {
        lane.reportError = error instanceof Error ? error.message : String(error);
      }
    }
    for (const lane of wave.lanes) {
      await freezeWriterLane(lane, { env, signal });
      await writeState(state, stateOptions);
    }
    for (const lane of wave.lanes) {
      const laneSnapshot = await gitSnapshot(lane.worktreePath, { signal });
      if (laneSnapshot.head !== wave.base.head) throw new Error(`Writer lane '${lane.id}' changed HEAD.`);
      lane.patch = await captureWriterDelta({
        worktree: lane.worktreePath,
        base: wave.base.head,
        baselineTree: lane.baseline?.tree,
        writeSet: lane.writeSet,
        patchPath: path.join(wave.root, "patches", `${lane.id}.patch`),
        maxFiles: config.policy.maxWriterFilesPerLane ?? 200,
        maxPatchBytes: config.policy.maxWriterPatchBytes ?? 16 * 1024 * 1024,
        signal,
      });
      lane.status = "captured";
      lane.capturedAt = now();
      await writeState(state, stateOptions);
    }
    wave.status = "validated";
    wave.validatedAt = now();
    await writeState(state, stateOptions);

    const integrationPath = path.join(wave.root, "integration");
    wave.integration = { path: integrationPath, status: "preparing" };
    await writeState(state, stateOptions);
    await createDetachedWorktree({ root: cwd, base: wave.base.head, worktreePath: integrationPath }, { signal });
    const integrationBaseline = await captureWriterBaseline({
      worktree: integrationPath,
      indexPath: path.join(wave.root, "baselines", "integration.index"),
      signal,
    });
    wave.integration.baseline = integrationBaseline;
    await writeState(state, stateOptions);
    const verifiedPatches = [];
    for (const lane of wave.lanes) verifiedPatches.push(await verifyPatch(lane.patch, wave.root));
    const nonEmptyPatches = verifiedPatches.filter((patch) => patch.content.length > 0);
    if (nonEmptyPatches.length) {
      const patchInput = concatenatePatches(nonEmptyPatches);
      await git(integrationPath, ["apply", "--check", "--binary"], { signal, env: gitEnvironment(), input: patchInput });
      await git(integrationPath, ["apply", "--binary"], { signal, env: gitEnvironment(), input: patchInput });
    }
    const combinedWriteSet = wave.lanes.flatMap((lane) => lane.writeSet);
    const combined = await captureWriterDelta({
      worktree: integrationPath,
      base: wave.base.head,
      baselineTree: integrationBaseline.tree,
      writeSet: combinedWriteSet,
      patchPath: path.join(wave.root, "patches", "combined.patch"),
      maxFiles: (config.policy.maxWriterFilesPerLane ?? 200) * wave.lanes.length,
      maxPatchBytes: config.policy.maxWriterPatchBytes ?? 16 * 1024 * 1024,
      signal,
    });
    wave.integration = { path: integrationPath, status: "verified", patch: combined, verifiedAt: now() };
    wave.status = "integrating";
    await writeState(state, stateOptions);

    const immediatelyBefore = await gitSnapshot(cwd, { signal });
    if (!immediatelyBefore.clean || immediatelyBefore.head !== wave.base.head || immediatelyBefore.branch !== wave.base.branch) {
      throw new Error("Builder changed during integration verification; no patch was applied.");
    }
    const builderBaseline = await captureWriterBaseline({
      worktree: cwd,
      indexPath: path.join(wave.root, "baselines", "builder.index"),
      signal,
    });
    if (builderBaseline.tree !== integrationBaseline.tree) {
      throw new Error("Builder raw filesystem baseline differs from the verified integration checkout; automatic integration refused.");
    }
    const verifiedCombined = await verifyPatch(combined, wave.root);
    if (verifiedCombined.content.length > 0) {
      await git(cwd, ["apply", "--check", "--binary"], { signal, env: gitEnvironment(), input: verifiedCombined.content });
      await git(cwd, ["apply", "--binary"], { signal, env: gitEnvironment(), input: verifiedCombined.content });
    }
    const builderPatch = await captureWriterDelta({
      worktree: cwd,
      base: wave.base.head,
      baselineTree: builderBaseline.tree,
      writeSet: combinedWriteSet,
      patchPath: path.join(wave.root, "patches", "builder-result.patch"),
      maxFiles: (config.policy.maxWriterFilesPerLane ?? 200) * wave.lanes.length,
      maxPatchBytes: config.policy.maxWriterPatchBytes ?? 16 * 1024 * 1024,
      signal,
    });
    if (builderPatch.digest !== combined.digest) throw new Error("Integrated Builder delta does not exactly match the verified combined writer patch.");

    wave.status = "integrated";
    wave.integratedAt = now();
    wave.builderPatch = builderPatch;
    await writeState(state, stateOptions);
    for (const lane of wave.lanes) {
      if (!lane.paneId || lane.paneClosedAt) continue;
      try {
        await closePane(lane.paneId, { signal, env });
        lane.paneClosedAt = now();
      } catch (error) {
        lane.paneCloseError = error instanceof Error ? error.message : String(error);
      }
    }
    await writeState(state, stateOptions);
    return { ok: true, waveId: wave.id, status: wave.status, changedPaths: builderPatch.changedPaths, patchDigest: builderPatch.digest, lanes: wave.lanes.map(({ id, label, patch, report, reportError }) => ({ id, label, changedPaths: patch.changedPaths, patchDigest: patch.digest, ...(report ? { report } : {}), ...(reportError ? { reportError } : {}) })) };
  } catch (error) {
    wave.status = "needs_reconciliation";
    wave.error = error instanceof Error ? error.message : String(error);
    wave.failedAt = now();
    await writeState(state, stateOptions);
    throw error;
  }
}

export async function resolveWriterWave({ runId, resolution, cwd = process.cwd(), env = process.env, signal, stateOptions = {} } = {}) {
  const state = await loadOwnedBuilder({ runId, cwd, env, stateOptions });
  const wave = currentWriterWave(state);
  if (!wave || wave.status !== "needs_reconciliation") throw new Error("No writer wave is awaiting manual reconciliation.");
  if (typeof resolution !== "string" || !resolution.trim()) throw new Error("Manual reconciliation requires a concrete resolution summary.");
  await refreshWaveStatus(state, wave, { env, signal, stateOptions });
  const unsettled = wave.lanes.find((lane) => lane.startedAt && !laneIsTerminal(lane));
  if (unsettled) throw new Error(`Writer lane '${unsettled.id}' is still '${unsettled.liveStatus}'; wait for it before recording reconciliation.`);
  wave.status = "reconciled";
  wave.resolution = resolution.trim();
  wave.reconciledAt = now();
  await writeState(state, stateOptions);
  for (const lane of wave.lanes) {
    if (!lane.paneId || lane.paneClosedAt) continue;
    try {
      await closePane(lane.paneId, { signal, env });
      lane.paneClosedAt = now();
    } catch (error) {
      lane.paneCloseError = error instanceof Error ? error.message : String(error);
    }
  }
  await writeState(state, stateOptions);
  return { ok: true, waveId: wave.id, status: wave.status, resolution: wave.resolution };
}
