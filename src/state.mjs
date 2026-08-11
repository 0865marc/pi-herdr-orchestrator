import { homedir } from "node:os";
import path from "node:path";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { shortHash, slugify } from "./naming.mjs";

export function stateRoot(env = process.env, home = homedir()) {
  const base = env.XDG_STATE_HOME ? path.resolve(env.XDG_STATE_HOME) : path.join(home, ".local", "state");
  return path.join(base, "pi-herdr-orchestrator", "runs");
}

export function dataRoot(env = process.env, home = homedir()) {
  const base = env.XDG_DATA_HOME ? path.resolve(env.XDG_DATA_HOME) : path.join(home, ".local", "share");
  return path.join(base, "pi-herdr-orchestrator");
}

export function worktreePathFor({ repository, project, task, runId, role }, options = {}) {
  const repoKey = `${slugify(project)}-${shortHash(repository, 8)}`;
  const roleSuffix = role ? `-${slugify(role, "role")}` : "";
  const taskKey = `${slugify(task, "task").slice(0, 36)}-${shortHash(runId, 6)}${roleSuffix}`;
  return path.join(options.root ?? dataRoot(options.env, options.home), "worktrees", repoKey, taskKey);
}

export function statePath(runId, options = {}) {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error(`Invalid workflow run id: ${runId}`);
  return path.join(options.root ?? stateRoot(options.env, options.home), `${runId}.json`);
}

export async function writeState(state, options = {}) {
  if (!state || state.schemaVersion !== 1 || typeof state.id !== "string") {
    throw new Error("Invalid workflow state.");
  }
  const file = statePath(state.id, options);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  return file;
}

export async function readState(runId, options = {}) {
  const file = statePath(runId, options);
  const parsed = JSON.parse(await readFile(file, "utf8"));
  if (!parsed || parsed.schemaVersion !== 1 || parsed.id !== runId) {
    throw new Error(`Unsupported or corrupt workflow state: ${file}`);
  }
  return parsed;
}

export async function listStates(options = {}) {
  const root = options.root ?? stateRoot(options.env, options.home);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const states = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await readFile(path.join(root, entry.name), "utf8"));
      if (parsed?.schemaVersion === 1 && typeof parsed.id === "string") states.push(parsed);
    } catch {
      // A damaged historical record must not make every new workflow unusable.
    }
  }
  return states.sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")));
}

export function resolveRunId(explicit, env = process.env) {
  const runId = explicit || env.PI_HERDR_ORCHESTRATOR_RUN_ID;
  if (!runId) throw new Error("A workflow run id is required.");
  return runId;
}
