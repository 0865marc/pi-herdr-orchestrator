import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { readState } from "../src/state.mjs";

const WRITER_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function inputPaths(input: Record<string, unknown>) {
  const values: string[] = [];
  if (typeof input.path === "string") values.push(input.path);
  if (typeof input.cwd === "string") values.push(input.cwd);
  if (Array.isArray(input.paths)) values.push(...input.paths.filter((value): value is string => typeof value === "string"));
  return values;
}

export function writerPathViolation(root: string, value: string, cwd = root): string | null {
  if (!value || value.includes("\0")) return "Writer paths must be non-empty and cannot contain NUL bytes.";
  if (path.isAbsolute(value)) return "Writer must use repository-relative paths inside its isolated worktree.";
  const assignedRoot = path.resolve(root);
  const candidate = path.resolve(cwd, value);
  if (!inside(assignedRoot, candidate)) return `Writer cannot access paths outside its isolated worktree: ${assignedRoot}`;
  const relative = path.relative(assignedRoot, candidate);
  if (relative.split(path.sep).some((segment) => segment.toLowerCase() === ".git")) {
    return "Writer cannot access Git administrative paths.";
  }

  const realRoot = realpathSync(assignedRoot);
  let current = assignedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!existsSync(current)) break;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) return `Writer cannot traverse symlinks: ${current}`;
    if (!inside(realRoot, realpathSync(current))) return `Writer path escapes its isolated worktree: ${current}`;
  }
  return null;
}

async function authorityViolation(root: string, cwd: string): Promise<string | null> {
  const runId = process.env.PI_HERDR_ORCHESTRATOR_RUN_ID;
  const waveId = process.env.PI_HERDR_ORCHESTRATOR_WRITER_WAVE_ID;
  const laneId = process.env.PI_HERDR_ORCHESTRATOR_WRITER_LANE_ID;
  if (process.env.PI_HERDR_ORCHESTRATOR_ROLE !== "writer" || !runId || !waveId || !laneId) {
    return "Writer guard is missing its controller-owned identity.";
  }
  if (path.resolve(root) !== path.resolve(cwd)) return "Writer session cwd does not match its assigned worktree.";
  try {
    const state = await readState(runId);
    const wave = state.parallelImplementation?.waves?.find((candidate: any) => candidate.id === waveId);
    const lane = wave?.lanes?.find((candidate: any) => candidate.id === laneId);
    if (!lane || path.resolve(lane.worktreePath ?? "") !== path.resolve(root)) {
      return "Writer identity is not registered in the owning workflow state.";
    }
    if (!lane.paneId || !process.env.HERDR_PANE_ID || lane.paneId !== process.env.HERDR_PANE_ID) {
      return "Writer pane does not match the controller-owned lane.";
    }
    const workspaceId = state.roles?.builder?.workspaceId;
    if (!workspaceId || !process.env.HERDR_WORKSPACE_ID || workspaceId !== process.env.HERDR_WORKSPACE_ID) {
      return "Writer workspace does not match the owning Builder workspace.";
    }
  } catch (error) {
    return `Writer authority could not be verified: ${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}

export default function writerGuard(pi: ExtensionAPI) {
  const root = process.env.PI_HERDR_ORCHESTRATOR_ROLE_ROOT;
  if (process.env.PI_HERDR_ORCHESTRATOR_ROLE !== "writer" || !root) return;
  let authorityError: string | null = "Writer authority has not been verified yet.";

  pi.on("session_start", async (_event, ctx) => {
    authorityError = await authorityViolation(root, ctx.cwd);
  });

  pi.on("tool_call", (event, ctx) => {
    if (authorityError) return { block: true, reason: authorityError };
    if (!WRITER_TOOLS.has(event.toolName)) {
      return { block: true, reason: `Writer tool '${event.toolName}' is outside the fixed no-shell capability set.` };
    }
    const input = (event.input ?? {}) as Record<string, unknown>;
    for (const candidate of inputPaths(input)) {
      const reason = writerPathViolation(root, candidate, ctx.cwd);
      if (reason) return { block: true, reason };
    }
  });
}
