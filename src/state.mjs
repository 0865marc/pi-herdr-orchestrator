import { homedir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { shortHash, slugify } from "./naming.mjs";

const STATE_BASE = Symbol("pi-herdr-orchestrator.state-base");
const MISSING = Symbol("pi-herdr-orchestrator.missing");

function clone(value) {
  return value === MISSING ? MISSING : structuredClone(value);
}

function equal(left, right) {
  if (left === MISSING || right === MISSING) return left === right;
  return isDeepStrictEqual(left, right);
}

function plainObject(value) {
  return value !== MISSING && value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeState(base, local, remote, trail = "state") {
  if (equal(local, base)) return clone(remote);
  if (equal(remote, base) || equal(local, remote)) return clone(local);
  if (plainObject(base) && plainObject(local) && plainObject(remote)) {
    const output = {};
    const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
    for (const key of keys) {
      const merged = mergeState(
        Object.hasOwn(base, key) ? base[key] : MISSING,
        Object.hasOwn(local, key) ? local[key] : MISSING,
        Object.hasOwn(remote, key) ? remote[key] : MISSING,
        `${trail}.${key}`,
      );
      if (merged !== MISSING) output[key] = merged;
    }
    return output;
  }
  throw new Error(`Concurrent workflow state conflict at '${trail}'; reload state and retry.`);
}

function attachBase(state, base = state) {
  Object.defineProperty(state, STATE_BASE, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: structuredClone(base),
  });
  return state;
}

async function withStateLock(file, operation) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 10_000;
  let handle;
  while (!handle) {
    try {
      handle = await open(lock, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
      } catch (error) {
        await handle.close();
        handle = undefined;
        try {
          await unlink(lock);
        } catch {
          // Preserve the original lock-write failure.
        }
        throw error;
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const stat = await lstat(lock);
        let ownerAlive = true;
        try {
          const ownerPid = Number.parseInt((await readFile(lock, "utf8")).split(/\s/u, 1)[0], 10);
          if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) ownerAlive = false;
          else process.kill(ownerPid, 0);
        } catch (ownerError) {
          if (ownerError?.code === "ESRCH") ownerAlive = false;
          else if (ownerError?.code !== "EPERM") ownerAlive = false;
        }
        if (!ownerAlive || Date.now() - stat.mtimeMs > 300_000) await unlink(lock);
      } catch (inspectionError) {
        if (inspectionError?.code !== "ENOENT") throw inspectionError;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring workflow state lock: ${lock}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await operation();
  } finally {
    const owned = await handle.stat();
    await handle.close();
    try {
      const current = await lstat(lock);
      if (owned.dev === current.dev && owned.ino === current.ino) await unlink(lock);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

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

export function writerWavePathFor({ runId, waveId }, options = {}) {
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || !/^[A-Za-z0-9._-]+$/.test(waveId)) {
    throw new Error("Invalid writer wave identifier.");
  }
  return path.join(options.root ?? dataRoot(options.env, options.home), "writer-waves", runId, waveId);
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
  const local = structuredClone(state);
  await withStateLock(file, async () => {
    let remote;
    try {
      remote = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    let output = local;
    if (remote) {
      const base = state[STATE_BASE];
      if (!base) {
        if (!equal(remote, local)) throw new Error(`Workflow state '${state.id}' already exists; read it before updating.`);
      } else {
        output = mergeState(base, local, remote);
      }
    }
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  });
  // Keep the caller's own view as its three-way-merge base. Concurrent fields that
  // it never observed remain remote-only and are preserved by later writes.
  attachBase(state, local);
  return file;
}

export async function updateState(runId, updater, options = {}) {
  if (typeof updater !== "function") throw new Error("Workflow state update requires a mutation callback.");
  const file = statePath(runId, options);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  return withStateLock(file, async () => {
    const state = JSON.parse(await readFile(file, "utf8"));
    if (!state || state.schemaVersion !== 1 || state.id !== runId) {
      throw new Error(`Unsupported or corrupt workflow state: ${file}`);
    }
    const updated = await updater(state) ?? state;
    if (!updated || updated.schemaVersion !== 1 || updated.id !== runId) {
      throw new Error("Workflow state mutation produced an invalid record.");
    }
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
    return attachBase(updated);
  });
}

export async function readState(runId, options = {}) {
  const file = statePath(runId, options);
  const parsed = JSON.parse(await readFile(file, "utf8"));
  if (!parsed || parsed.schemaVersion !== 1 || parsed.id !== runId) {
    throw new Error(`Unsupported or corrupt workflow state: ${file}`);
  }
  return attachBase(parsed);
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
