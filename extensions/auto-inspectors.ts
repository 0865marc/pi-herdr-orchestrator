import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ASYNC_STARTED = "subagent:async-started";
const ASYNC_COMPLETE = "subagent:async-complete";
const runnerPath = fileURLToPath(new URL("../node_modules/pi-subagents/inspector-runner.mjs", import.meta.url));
const registryKey = Symbol.for("pi-herdr-orchestrator:auto-inspectors");

function shellQuote(value: string): string {
  if (process.platform === "win32") return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function inspectorCommand(asyncDir: string, runId: string, index?: number): string {
  const args = [
    process.execPath,
    runnerPath,
    "--async-dir", asyncDir,
    "--run-id", runId,
    "--allow-steer", "false",
    "--allow-stop", "false",
  ];
  if (index !== undefined) args.push("--index", String(index));
  return args.map(shellQuote).join(" ");
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

async function bindingPaneIds(file: string): Promise<string[]> {
  try {
    const binding = JSON.parse(await readFile(file, "utf8"));
    if (Array.isArray(binding.panes)) {
      return binding.panes
        .map((pane: unknown) => pane && typeof pane === "object" ? (pane as Record<string, unknown>).paneId : undefined)
        .filter((paneId: unknown): paneId is string => typeof paneId === "string");
    }
    return typeof binding.paneId === "string" ? [binding.paneId] : [];
  } catch {
    return [];
  }
}

async function writeBinding(file: string, binding: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(binding, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

interface InspectorTarget {
  agent: string;
  label: string;
  index?: number;
}

function workflowGraphTargets(data: Record<string, unknown>): InspectorTarget[] {
  const graph = data.workflowGraph;
  if (!graph || typeof graph !== "object" || !Array.isArray((graph as Record<string, unknown>).nodes)) return [];
  const targets: InspectorTarget[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const item = node as Record<string, unknown>;
    const agent = typeof item.agent === "string" ? item.agent : undefined;
    const index = typeof item.flatIndex === "number" && Number.isInteger(item.flatIndex) ? item.flatIndex : undefined;
    if (agent && index !== undefined) {
      targets.push({
        agent,
        index,
        label: typeof item.label === "string" && item.label.trim() ? item.label.trim() : agent,
      });
    }
    if (Array.isArray(item.children)) item.children.forEach(visit);
  };
  ((graph as Record<string, unknown>).nodes as unknown[]).forEach(visit);
  return targets.sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
}

function inspectorTargets(data: Record<string, unknown>, limit: number): InspectorTarget[] {
  const workflowTargets = workflowGraphTargets(data);
  if (workflowTargets.length > 0) return workflowTargets.slice(0, limit);
  const agents = Array.isArray(data.agents)
    ? data.agents.filter((agent): agent is string => typeof agent === "string")
    : [];
  if (agents.length > 1) {
    return agents.slice(0, limit).map((agent, index) => ({ agent, label: agent, index }));
  }
  const agent = typeof data.agent === "string" ? data.agent : agents[0] || "subagent";
  return limit > 0 ? [{ agent, label: agent }] : [];
}

function paneLabel(target: InspectorTarget): string {
  const sanitized = target.label
    .replace(/^pi-herdr-orchestrator\./u, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return (sanitized || target.agent.replace(/^pi-herdr-orchestrator\./u, "") || "subagent").slice(0, 48);
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
  const role = options.role || process.env.PI_HERDR_ORCHESTRATOR_ROLE;
  const sourcePaneId = options.sourcePaneId || process.env.HERDR_PANE_ID;
  if (!role || !sourcePaneId || process.env.PI_SUBAGENT_CHILD === "1" || !pi.events?.on) return () => {};
  const registry = ((globalThis as Record<PropertyKey, unknown>)[registryKey] ??= new Set<string>()) as Set<string>;
  const instanceKey = `${options.runId || process.env.PI_HERDR_ORCHESTRATOR_RUN_ID || "run"}:${role}:${sourcePaneId}`;
  if (registry.has(instanceKey)) return () => {};
  registry.add(instanceKey);
  const requestedMax = options.maxPanes ?? Number.parseInt(process.env.PI_HERDR_ORCHESTRATOR_MAX_INSPECTOR_PANES || "3", 10);
  const maxPanes = Number.isFinite(requestedMax) ? Math.max(0, Math.min(requestedMax, 6)) : 3;
  const openedRuns = new Set<string>();
  const openedPanes = new Map<string, string[]>();
  const completedRuns = new Set<string>();
  let openedPaneCount = 0;
  let queue = Promise.resolve();

  const releaseCompletedPanes = async () => {
    for (const runId of completedRuns) {
      const paneIds = openedPanes.get(runId) ?? [];
      for (const paneId of paneIds) {
        await pi.exec(process.env.HERDR_BIN || "herdr", ["pane", "close", paneId], { timeout: 5_000 });
      }
      openedPaneCount = Math.max(0, openedPaneCount - paneIds.length);
      openedPanes.delete(runId);
      openedRuns.delete(runId);
      completedRuns.delete(runId);
    }
  };

  const openInspector = async (payload: unknown) => {
    if (options.isActive?.() === false || !payload || typeof payload !== "object" || maxPanes === 0) return;
    await releaseCompletedPanes();
    if (openedPaneCount >= maxPanes) return;
    const data = payload as Record<string, unknown>;
    const runId = typeof data.id === "string" ? data.id : undefined;
    const asyncDir = typeof data.asyncDir === "string" ? path.resolve(data.asyncDir) : undefined;
    if (!runId || !asyncDir || openedRuns.has(runId)) return;
    const bindingFile = path.join(asyncDir, "inspectors", "herdr.json");
    if (await bindingExists(bindingFile)) {
      const paneIds = await bindingPaneIds(bindingFile);
      openedPanes.set(runId, paneIds);
      openedPaneCount = Math.min(maxPanes, openedPaneCount + paneIds.length);
      openedRuns.add(runId);
      return;
    }
    const cwd = typeof data.cwd === "string" ? data.cwd : options.roleRoot || process.env.PI_HERDR_ORCHESTRATOR_ROLE_ROOT || process.cwd();
    const targets = inspectorTargets(data, maxPanes - openedPaneCount);
    const panes: Array<Record<string, unknown>> = [];
    openedRuns.add(runId);
    for (const target of targets) {
      const split = parseHerdr(await pi.exec(process.env.HERDR_BIN || "herdr", [
        "pane", "split", "--pane", sourcePaneId, "--direction", "right", "--cwd", cwd, "--no-focus",
      ], { timeout: 15_000 }), "Herdr inspector pane split");
      const paneId = split?.result?.pane?.pane_id;
      if (typeof paneId !== "string") throw new Error("Herdr inspector pane split returned no pane id.");
      const command = inspectorCommand(asyncDir, runId, target.index);
      const displayLabel = paneLabel(target);
      try {
        parseHerdr(await pi.exec(process.env.HERDR_BIN || "herdr", [
          "pane", "run", paneId, command,
        ], { timeout: 15_000 }), "Herdr inspector runner start");
        await pi.exec(process.env.HERDR_BIN || "herdr", [
          "pane", "rename", paneId, `subagent · ${displayLabel}`,
        ], { timeout: 5_000 });
        panes.push({
          paneId,
          agent: target.agent,
          label: target.label,
          ...(target.index === undefined ? {} : { index: target.index }),
          openedAt: new Date().toISOString(),
          command,
        });
        openedPaneCount += 1;
        openedPanes.set(runId, panes.map((pane) => pane.paneId as string));
        await writeBinding(bindingFile, {
          schemaVersion: 2,
          kind: "herdr-subagent-inspectors",
          runId,
          asyncDir,
          panes,
        });
      } catch (error) {
        await pi.exec(process.env.HERDR_BIN || "herdr", ["pane", "close", paneId], { timeout: 5_000 });
        throw error;
      }
    }
  };

  const unsubscribe = pi.events.on(ASYNC_STARTED, (payload: unknown) => {
    queue = queue.then(() => openInspector(payload)).catch((error) => {
      console.error("Failed to open automatic Herdr subagent inspector:", error);
    });
  });
  const unsubscribeComplete = pi.events.on(ASYNC_COMPLETE, (payload: unknown) => {
    if (!payload || typeof payload !== "object") return;
    const data = payload as Record<string, unknown>;
    const runId = typeof data.id === "string" ? data.id : data.runId;
    if (typeof runId === "string" && openedRuns.has(runId)) completedRuns.add(runId);
  });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    unsubscribeComplete();
    registry.delete(instanceKey);
  };
  pi.on("session_shutdown", dispose);
  return dispose;
}

export default function autoInspectors(pi: ExtensionAPI) {
  installAutoInspectors(pi);
}
