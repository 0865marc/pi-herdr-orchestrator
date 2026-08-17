import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

interface InspectorPane {
  paneId: string;
  agent?: string;
  label?: string;
  index?: number;
  openedAt?: string;
  command?: string;
}

interface InspectorBinding {
  schemaVersion: 1 | 2;
  kind: "herdr-inspector" | "herdr-subagent-inspectors";
  runId: string;
  asyncDir: string;
  panes: InspectorPane[];
}

type PrimaryInspectorSlot = "rightTop" | "rightBottom" | "lowerLeft";

interface InspectorSplit {
  paneId: string;
  direction: "right" | "down";
  primarySlot?: PrimaryInspectorSlot;
}

interface InspectorTarget {
  agent: string;
  label: string;
  index?: number;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUsablePaneId(value: unknown): value is string {
  return isNonEmptyString(value) && value === value.trim() && !/[\u0000-\u001F\u007F]/u.test(value);
}

function parseInspectorBinding(value: unknown): InspectorBinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (!isNonEmptyString(input.runId) || !isNonEmptyString(input.asyncDir)) return undefined;

  if (
    input.schemaVersion === 1
    && input.kind === "herdr-inspector"
    && isUsablePaneId(input.paneId)
    && isNonEmptyString(input.openedAt)
    && isNonEmptyString(input.command)
  ) {
    return {
      schemaVersion: 1,
      kind: "herdr-inspector",
      runId: input.runId,
      asyncDir: input.asyncDir,
      panes: [{ paneId: input.paneId, openedAt: input.openedAt, command: input.command }],
    };
  }

  if (input.schemaVersion !== 2 || input.kind !== "herdr-subagent-inspectors" || !Array.isArray(input.panes) || input.panes.length === 0) {
    return undefined;
  }
  const paneIds = new Set<string>();
  const panes: InspectorPane[] = [];
  for (const value of input.panes) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const pane = value as Record<string, unknown>;
    if (!isUsablePaneId(pane.paneId) || paneIds.has(pane.paneId)) return undefined;
    paneIds.add(pane.paneId);
    panes.push({
      paneId: pane.paneId,
      ...(isNonEmptyString(pane.agent) ? { agent: pane.agent } : {}),
      ...(isNonEmptyString(pane.label) ? { label: pane.label } : {}),
      ...(typeof pane.index === "number" && Number.isInteger(pane.index) ? { index: pane.index } : {}),
      ...(isNonEmptyString(pane.openedAt) ? { openedAt: pane.openedAt } : {}),
      ...(isNonEmptyString(pane.command) ? { command: pane.command } : {}),
    });
  }
  return {
    schemaVersion: 2,
    kind: "herdr-subagent-inspectors",
    runId: input.runId,
    asyncDir: input.asyncDir,
    panes,
  };
}

async function readInspectorBinding(file: string): Promise<{ exists: boolean; binding?: InspectorBinding }> {
  try {
    return { exists: true, binding: parseInspectorBinding(JSON.parse(await readFile(file, "utf8"))) };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return { exists: code !== "ENOENT" };
  }
}

async function writeBinding(file: string, binding: InspectorBinding): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(binding, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
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

function plannedOverflowSplit(sourcePaneId: string, inspectorPaneIds: readonly string[]): InspectorSplit {
  const targets = [sourcePaneId, ...inspectorPaneIds];
  return {
    paneId: targets[(inspectorPaneIds.length - 3) % targets.length],
    direction: inspectorPaneIds.length % 2 === 1 ? "right" : "down",
  };
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
  const primarySlots: Partial<Record<PrimaryInspectorSlot, string>> = {};
  let initializedPaneIds: string[] = [];
  let queue = Promise.resolve();

  const paneIsLive = async (paneId: string): Promise<boolean> => {
    try {
      parseHerdr(await pi.exec(process.env.HERDR_BIN || "herdr", ["pane", "get", paneId], { timeout: 5_000 }), "Herdr inspector pane lookup");
      return true;
    } catch {
      return false;
    }
  };
  const normalizePrimarySlots = () => {
    if (!primarySlots.rightTop && primarySlots.rightBottom) {
      primarySlots.rightTop = primarySlots.rightBottom;
      delete primarySlots.rightBottom;
    }
  };
  const forgetInitializedPane = (paneId: string) => {
    initializedPaneIds = initializedPaneIds.filter((knownPaneId) => knownPaneId !== paneId);
    if (primarySlots.rightTop === paneId) delete primarySlots.rightTop;
    if (primarySlots.rightBottom === paneId) delete primarySlots.rightBottom;
    if (primarySlots.lowerLeft === paneId) delete primarySlots.lowerLeft;
    normalizePrimarySlots();
  };
  const pruneUnavailablePanes = async () => {
    const unavailablePaneIds: string[] = [];
    for (const paneId of initializedPaneIds) {
      if (!await paneIsLive(paneId)) unavailablePaneIds.push(paneId);
    }
    for (const paneId of unavailablePaneIds) {
      forgetInitializedPane(paneId);
      for (const [runId, paneIds] of openedPanes) {
        const livePaneIds = paneIds.filter((knownPaneId) => knownPaneId !== paneId);
        if (livePaneIds.length !== paneIds.length) openedPanes.set(runId, livePaneIds);
      }
    }
  };
  const nextPrimarySlot = (): PrimaryInspectorSlot | undefined => {
    if (!primarySlots.rightTop) return "rightTop";
    if (!primarySlots.rightBottom) return "rightBottom";
    if (!primarySlots.lowerLeft) return "lowerLeft";
    return undefined;
  };
  const rememberInitializedPane = (paneId: string, primarySlot?: PrimaryInspectorSlot) => {
    if (!initializedPaneIds.includes(paneId)) initializedPaneIds.push(paneId);
    if (primarySlot) primarySlots[primarySlot] = paneId;
  };
  const nextSplit = (): InspectorSplit => {
    const rightTop = primarySlots.rightTop;
    if (!rightTop) return { paneId: sourcePaneId, direction: "right", primarySlot: "rightTop" };
    if (!primarySlots.rightBottom) return { paneId: rightTop, direction: "down", primarySlot: "rightBottom" };
    if (!primarySlots.lowerLeft) return { paneId: sourcePaneId, direction: "down", primarySlot: "lowerLeft" };
    return plannedOverflowSplit(sourcePaneId, initializedPaneIds);
  };
  const releaseCompletedPanes = async () => {
    for (const runId of completedRuns) {
      const paneIds = openedPanes.get(runId) ?? [];
      for (const paneId of paneIds) {
        await pi.exec(process.env.HERDR_BIN || "herdr", ["pane", "close", paneId], { timeout: 5_000 });
        forgetInitializedPane(paneId);
      }
      openedPanes.delete(runId);
      openedRuns.delete(runId);
      completedRuns.delete(runId);
    }
  };

  const openInspector = async (payload: unknown) => {
    if (options.isActive?.() === false || !payload || typeof payload !== "object" || maxPanes === 0) return;
    await releaseCompletedPanes();
    await pruneUnavailablePanes();
    const data = payload as Record<string, unknown>;
    const runId = typeof data.id === "string" ? data.id : undefined;
    const asyncDir = typeof data.asyncDir === "string" ? path.resolve(data.asyncDir) : undefined;
    if (!runId || !asyncDir || openedRuns.has(runId)) return;
    const bindingFile = path.join(asyncDir, "inspectors", "herdr.json");
    const existing = await readInspectorBinding(bindingFile);
    if (existing.exists) {
      openedRuns.add(runId);
      const binding = existing.binding;
      if (binding && binding.runId === runId && path.resolve(binding.asyncDir) === asyncDir) {
        const recoveredPaneIds: string[] = [];
        for (const pane of binding.panes) {
          if (
            pane.paneId !== sourcePaneId
            && !initializedPaneIds.includes(pane.paneId)
            && await paneIsLive(pane.paneId)
          ) {
            recoveredPaneIds.push(pane.paneId);
            rememberInitializedPane(pane.paneId, nextPrimarySlot());
          }
        }
        openedPanes.set(runId, recoveredPaneIds);
      }
      return;
    }
    if (initializedPaneIds.length >= maxPanes) return;

    const cwd = typeof data.cwd === "string" ? data.cwd : options.roleRoot || process.env.PI_HERDR_ORCHESTRATOR_ROLE_ROOT || process.cwd();
    const targets = inspectorTargets(data, maxPanes - initializedPaneIds.length);
    if (targets.length === 0) return;
    const panes: InspectorPane[] = [];
    openedRuns.add(runId);
    for (const target of targets) {
      if (initializedPaneIds.length >= maxPanes) break;
      const plannedSplit = nextSplit();
      const split = parseHerdr(await pi.exec(process.env.HERDR_BIN || "herdr", [
        "pane", "split", "--pane", plannedSplit.paneId, "--direction", plannedSplit.direction, "--ratio", "0.5", "--cwd", cwd, "--no-focus",
      ], { timeout: 15_000 }), "Herdr inspector pane split");
      const paneId = split?.result?.pane?.pane_id;
      if (!isUsablePaneId(paneId) || paneId === sourcePaneId) throw new Error("Herdr inspector pane split returned no usable pane id.");
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
        await writeBinding(bindingFile, {
          schemaVersion: 2,
          kind: "herdr-subagent-inspectors",
          runId,
          asyncDir,
          panes,
        });
        openedPanes.set(runId, panes.map((pane) => pane.paneId));
        rememberInitializedPane(paneId, plannedSplit.primarySlot);
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
