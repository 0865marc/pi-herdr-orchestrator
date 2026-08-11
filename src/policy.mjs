import path from "node:path";

const PATH_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);
const MUTATION_TOOLS = new Set(["edit", "write"]);

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function candidatePaths(input, cwd) {
  const values = [];
  if (typeof input?.path === "string") values.push(input.path);
  if (typeof input?.cwd === "string") values.push(input.cwd);
  if (Array.isArray(input?.paths)) values.push(...input.paths.filter((value) => typeof value === "string"));
  return values.map((value) => path.resolve(cwd, value));
}

function hasShellComposition(command) {
  return /[\n\r;&|><`]|\$\(|\$\{|\b(eval|exec)\b/u.test(command);
}

function allowedReviewerCommand(command, prefixes) {
  const normalized = command.trim().replace(/\s+/gu, " ");
  if (!normalized || hasShellComposition(normalized)) return false;
  return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `));
}

export function decideToolCall({ role, isChild = false, toolName, input = {}, root, readRoots = [], cwd = root, policy }) {
  if (!role || !["orchestrator", "scout", "builder", "reviewer"].includes(role)) return null;
  const resolvedRoot = path.resolve(root);
  const resolvedCwd = path.resolve(cwd || root);
  const resolvedReadRoots = [resolvedRoot, ...readRoots.map((value) => path.resolve(value))];

  if (PATH_TOOLS.has(toolName)) {
    const allowedRoots = MUTATION_TOOLS.has(toolName) ? [resolvedRoot] : resolvedReadRoots;
    const outside = candidatePaths(input, resolvedCwd).find((candidate) => !allowedRoots.some((allowed) => isInside(allowed, candidate)));
    if (outside) return `Role '${role}' cannot access paths outside its assigned root: ${resolvedRoot}`;
  }

  if (toolName === "herdr_workflow" && input.action === "start") {
    return "This workflow is already running; an active role cannot start another Orchestrator.";
  }

  if (toolName === "subagent" && typeof input.action !== "string") {
    if (typeof input.cwd === "string" && !isInside(resolvedRoot, path.resolve(resolvedCwd, input.cwd))) {
      return `Role '${role}' cannot launch subagents outside its assigned root: ${resolvedRoot}`;
    }
    if (typeof input.workflowScript !== "string" || !input.workflowScript.trim()) {
      return "Workflow roles must delegate through workflowScript so the run is asynchronous and visible in a Herdr inspector pane.";
    }
    if (input.async === false) {
      return "Workflow-role subagents must run asynchronously so Herdr can open their inspector panes.";
    }
    if (input.artifacts !== false || input.mission !== false) {
      return "Workflow-role subagents must set artifacts:false and mission:false so pi-subagents does not dirty the target repository.";
    }
  }

  if (isChild && role === "builder" && (MUTATION_TOOLS.has(toolName) || toolName === "bash")) {
    return "Nested Builder subagents are read-only; the top-level Builder is the single writer.";
  }

  if ((role === "orchestrator" || role === "scout") && (MUTATION_TOOLS.has(toolName) || toolName === "bash")) {
    return `Role '${role}' cannot mutate files or run a general shell.`;
  }

  if (role === "reviewer" && MUTATION_TOOLS.has(toolName)) {
    return "Reviewer is read-only and cannot edit or write files.";
  }

  if (role === "reviewer" && toolName === "bash") {
    const command = typeof input.command === "string" ? input.command : "";
    if (!allowedReviewerCommand(command, policy.reviewerAllowedCommands ?? [])) {
      return "Reviewer shell command is outside the configured read-only/test allowlist.";
    }
  }

  if (role === "builder" && toolName === "bash") {
    const command = typeof input.command === "string" ? input.command : "";
    for (const source of policy.builderDeniedPatterns ?? []) {
      if (new RegExp(source, "iu").test(command)) {
        return "Builder shell command matches a denied publishing, history-changing, privilege, or destructive pattern.";
      }
    }
  }

  return null;
}
