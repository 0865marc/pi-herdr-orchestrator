import { runChecked } from "./process.mjs";

export function assertHerdrContext(env = process.env) {
  if (env.HERDR_ENV !== "1") throw new Error("This operation must run inside Herdr (HERDR_ENV=1).");
  if (!env.HERDR_SOCKET_PATH || !env.HERDR_PANE_ID) {
    throw new Error("Herdr socket and pane context are required.");
  }
}

export async function herdr(args, options = {}) {
  const result = await runChecked(options.bin ?? "herdr", args, {
    ...options,
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  const text = result.stdout.trim();
  if (!text) return { result: { type: "ok" } };
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Herdr returned non-JSON output for '${args.join(" ")}': ${text}`, { cause: error });
  }
}

export async function createWorkspace({ cwd, label, env = {}, focus = false }, options = {}) {
  const args = ["workspace", "create", "--cwd", cwd, "--label", label];
  for (const [key, value] of Object.entries(env)) args.push("--env", `${key}=${value}`);
  args.push(focus ? "--focus" : "--no-focus");
  const response = await herdr(args, options);
  const workspaceId = response?.result?.workspace?.workspace_id;
  const paneId = response?.result?.root_pane?.pane_id;
  if (!workspaceId || !paneId) throw new Error("Herdr workspace creation returned no workspace or root pane id.");
  return { response, workspaceId, paneId };
}

export async function workspaceGet(workspaceId, options = {}) {
  return herdr(["workspace", "get", workspaceId], options);
}

export async function renameWorkspace(workspaceId, label, options = {}) {
  return herdr(["workspace", "rename", workspaceId, label], options);
}

export async function renameAgent(target, name, options = {}) {
  return herdr(["agent", "rename", target, name], options);
}

export async function clearAgentName(target, options = {}) {
  return herdr(["agent", "rename", target, "--clear"], options);
}

export async function openWorktreeWorkspace({ sourceWorkspaceId, cwd, label, env = {}, focus = false }, options = {}) {
  const openResponse = await herdr([
    "worktree", "open",
    "--workspace", sourceWorkspaceId,
    "--path", cwd,
    "--label", label,
    focus ? "--focus" : "--no-focus",
  ], options);
  if (openResponse?.result?.already_open === true) {
    throw new Error(`Herdr already has a workspace open for role worktree: ${cwd}`);
  }
  const workspaceId = openResponse?.result?.workspace?.workspace_id;
  const shellPaneId = openResponse?.result?.root_pane?.pane_id;
  if (!workspaceId || !shellPaneId) {
    throw new Error("Herdr worktree opening returned no workspace or root pane id.");
  }

  // worktree.open cannot inject launch environment. Replace its blank shell
  // with an env-aware shell before starting Pi, while preserving the worktree
  // provenance that makes Herdr render this workspace under the Orchestrator.
  const splitArgs = ["pane", "split", "--pane", shellPaneId, "--direction", "right", "--cwd", cwd];
  for (const [key, value] of Object.entries(env)) splitArgs.push("--env", `${key}=${value}`);
  splitArgs.push("--no-focus");
  const splitResponse = await herdr(splitArgs, options);
  const paneId = splitResponse?.result?.pane?.pane_id;
  if (!paneId) throw new Error("Herdr pane split returned no environment-aware pane id.");
  const closeResponse = await herdr(["pane", "close", shellPaneId], options);
  return {
    response: { worktreeOpen: openResponse, environmentPane: splitResponse, blankPaneClosed: closeResponse },
    workspaceId,
    paneId,
  };
}

export async function startPiAgent({ name, paneId, args, timeoutMs = 60_000 }, options = {}) {
  return herdr([
    "agent", "start", name,
    "--kind", "pi",
    "--pane", paneId,
    "--timeout", String(timeoutMs),
    "--",
    ...args,
  ], { ...options, timeoutMs: timeoutMs + 5_000 });
}

export async function agentGet(target, options = {}) {
  return herdr(["agent", "get", target], options);
}

export async function agentPrompt(target, text, { wait = false, timeoutMs = 1_200_000, ...options } = {}) {
  const args = ["agent", "prompt", target, text];
  if (wait) args.push("--wait", "--timeout", String(timeoutMs));
  return herdr(args, { ...options, timeoutMs: wait ? timeoutMs + 5_000 : 30_000 });
}

export async function agentWait(target, timeoutMs = 1_200_000, options = {}) {
  return herdr(["agent", "wait", target, "--timeout", String(timeoutMs)], { ...options, timeoutMs: timeoutMs + 5_000 });
}

export async function agentRead(target, lines = 160, options = {}) {
  return herdr(["agent", "read", target, "--source", "recent-unwrapped", "--lines", String(lines)], options);
}

export async function closeWorkspace(workspaceId, options = {}) {
  return herdr(["workspace", "close", workspaceId], options);
}
