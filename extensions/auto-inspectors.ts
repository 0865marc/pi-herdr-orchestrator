import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ASYNC_STARTED = "subagent:async-started";
const runnerPath = fileURLToPath(new URL("../node_modules/pi-subagents/inspector-runner.mjs", import.meta.url));
const registryKey = Symbol.for("herdr-workflow:auto-inspectors");

function shellQuote(value: string): string {
  if (process.platform === "win32") return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function inspectorCommand(asyncDir: string, runId: string): string {
  return [
    process.execPath,
    runnerPath,
    "--async-dir", asyncDir,
    "--run-id", runId,
    "--allow-steer", "false",
    "--allow-stop", "false",
  ].map(shellQuote).join(" ");
}

function parseHerdr(result: { code?: number; stdout?: string; stderr?: string }, operation: string): Record<string, any> {
  if (result.code !== 0) throw new Error(`${operation} failed: ${result.stderr || result.stdout || `exit ${result.code}`}`);
  try {
    return JSON.parse(result.stdout || "{}");
  } catch (error) {
    throw new Error(`${operation} returned invalid JSON.`, { cause: error });
  }
}

async function bindingExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export interface AutoInspectorOptions {
  role?: string;
  runId?: string;
  sourcePaneId?: string;
  roleRoot?: string;
  maxPanes?: number;
  isActive?: () => boolean;
}

export function installAutoInspectors(pi: ExtensionAPI, options: AutoInspectorOptions = {}): () => void {
  const role = options.role || process.env.HERDR_WORKFLOW_ROLE;
  const sourcePaneId = options.sourcePaneId || process.env.HERDR_PANE_ID;
  if (!role || !sourcePaneId || process.env.PI_SUBAGENT_CHILD === "1" || !pi.events?.on) return () => {};
  const registry = ((globalThis as Record<PropertyKey, unknown>)[registryKey] ??= new Set<string>()) as Set<string>;
  const instanceKey = `${options.runId || process.env.HERDR_WORKFLOW_RUN_ID || "run"}:${role}:${sourcePaneId}`;
  if (registry.has(instanceKey)) return () => {};
  registry.add(instanceKey);
  const requestedMax = options.maxPanes ?? Number.parseInt(process.env.HERDR_WORKFLOW_MAX_INSPECTOR_PANES || "3", 10);
  const maxPanes = Number.isFinite(requestedMax) ? Math.max(0, Math.min(requestedMax, 6)) : 3;
  const openedRuns = new Set<string>();
  let queue = Promise.resolve();

  const openInspector = async (payload: unknown) => {
    if (options.isActive?.() === false || !payload || typeof payload !== "object" || maxPanes === 0 || openedRuns.size >= maxPanes) return;
    const data = payload as Record<string, unknown>;
    const runId = typeof data.id === "string" ? data.id : undefined;
    const asyncDir = typeof data.asyncDir === "string" ? path.resolve(data.asyncDir) : undefined;
    if (!runId || !asyncDir || openedRuns.has(runId)) return;
    const bindingFile = path.join(asyncDir, "inspectors", "herdr.json");
    if (await bindingExists(bindingFile)) {
      openedRuns.add(runId);
      return;
    }
    const cwd = typeof data.cwd === "string" ? data.cwd : options.roleRoot || process.env.HERDR_WORKFLOW_ROLE_ROOT || process.cwd();
    const split = parseHerdr(await pi.exec(process.env.HERDR_BIN || "herdr", [
      "pane", "split", "--pane", sourcePaneId, "--direction", "right", "--cwd", cwd, "--no-focus",
    ], { timeout: 15_000 }), "Herdr inspector pane split");
    const paneId = split?.result?.pane?.pane_id;
    if (typeof paneId !== "string") throw new Error("Herdr inspector pane split returned no pane id.");
    try {
      parseHerdr(await pi.exec(process.env.HERDR_BIN || "herdr", [
        "pane", "run", paneId, inspectorCommand(asyncDir, runId),
      ], { timeout: 15_000 }), "Herdr inspector runner start");
      await mkdir(path.dirname(bindingFile), { recursive: true });
      const binding = {
        schemaVersion: 1,
        kind: "herdr-inspector",
        runId,
        asyncDir,
        paneId,
        openedAt: new Date().toISOString(),
        command: inspectorCommand(asyncDir, runId),
      };
      const temporary = `${bindingFile}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(binding, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, bindingFile);
      openedRuns.add(runId);
      await pi.exec(process.env.HERDR_BIN || "herdr", ["pane", "rename", paneId, `subagent ${runId.slice(0, 8)}`], { timeout: 5_000 });
    } catch (error) {
      await pi.exec(process.env.HERDR_BIN || "herdr", ["pane", "close", paneId], { timeout: 5_000 });
      throw error;
    }
  };

  const unsubscribe = pi.events.on(ASYNC_STARTED, (payload: unknown) => {
    queue = queue.then(() => openInspector(payload)).catch((error) => {
      console.error("Failed to open automatic Herdr subagent inspector:", error);
    });
  });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    registry.delete(instanceKey);
  };
  pi.on("session_shutdown", dispose);
  return dispose;
}

export default function autoInspectors(pi: ExtensionAPI) {
  installAutoInspectors(pi);
}
