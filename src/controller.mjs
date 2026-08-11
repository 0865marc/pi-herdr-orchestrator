import path from "node:path";
import { basename } from "node:path";
import { mkdir } from "node:fs/promises";
import { commandExists, runProcess } from "./process.mjs";
import { loadConfig, PACKAGE_ROOT, assertPackageReady, resolveLaunchMode, roleArgs } from "./config.mjs";
import { assertCleanSnapshot, assertSnapshotUnchanged, createDetachedWorktree, createLinkedWorktree, gitSnapshot, validateBranch } from "./git.mjs";
import {
  assertHerdrContext,
  createWorkspace,
  openWorktreeWorkspace,
  startPiAgent,
  agentGet,
  agentPrompt,
  agentRead,
  agentWait,
  closeWorkspace,
} from "./herdr.mjs";
import { agentName, createRunId, defaultTaskBranch, workspaceLabel } from "./naming.mjs";
import { listStates, readState, resolveRunId, statePath, worktreePathFor, writeState } from "./state.mjs";
import { syncReviewSnapshot } from "./review-snapshot.mjs";

function now() {
  return new Date().toISOString();
}

function runtimeDirectory(runId, role, stateOptions = {}) {
  const stateFile = statePath(runId, stateOptions);
  return path.join(path.dirname(stateFile), runId, "sessions", role);
}

function workflowEnv(state, role, cwd, root = PACKAGE_ROOT, config = {}) {
  return {
    PI_HERDR_ORCHESTRATOR_RUN_ID: state.id,
    PI_HERDR_ORCHESTRATOR_ROLE: role,
    PI_HERDR_ORCHESTRATOR_REPO_ROOT: state.repository.root,
    PI_HERDR_ORCHESTRATOR_ROLE_ROOT: cwd,
    PI_HERDR_ORCHESTRATOR_PACKAGE_ROOT: root,
    PI_HERDR_ORCHESTRATOR_MAX_INSPECTOR_PANES: String(config.policy?.maxInspectorPanesPerRole ?? 3),
  };
}

function assertApproved(approved, action) {
  if (approved !== true) throw new Error(`${action} requires explicit user approval.`);
}

export function assertWorkflowStartAuthority(env = process.env) {
  if (env.PI_HERDR_ORCHESTRATOR_ROLE || env.PI_HERDR_ORCHESTRATOR_RUN_ID) {
    throw new Error("An active workflow role cannot start another workflow. Continue through the owning Orchestrator.");
  }
}

function assertOrchestratorAuthority(state, env = process.env) {
  if (env.PI_HERDR_ORCHESTRATOR_ROLE !== "orchestrator" || env.PI_HERDR_ORCHESTRATOR_RUN_ID !== state.id) {
    throw new Error("Only the owning top-level Orchestrator may control workflow roles.");
  }
}

function roleRecord(response, workspaceId, paneId, name, cwd) {
  return {
    workspaceId,
    paneId,
    agentName: name,
    cwd,
    startedAt: now(),
    status: "running",
    startResponse: response,
  };
}

export function orchestratorInitialPrompt(state) {
  return [
    `You are already bootstrapped as the Orchestrator for workflow run ${state.id}.`,
    "Do not call pi_herdr_orchestrator.start. Use status and start_role to coordinate this existing run.",
    `The approved clean base is ${state.repository.branch}@${state.repository.head}.`,
    "",
    "User task:",
    state.task,
  ].join("\n");
}

async function reusableWorkflow(snapshot, task, { signal, env, stateOptions }) {
  const states = await listStates(stateOptions);
  for (const state of states) {
    if (path.resolve(state.repository?.root ?? "") !== snapshot.root || state.task?.trim() !== task) continue;
    const orchestrator = state.roles?.orchestrator;
    if (!orchestrator?.agentName || ["closed", "completed", "start_failed"].includes(orchestrator.status)) continue;
    try {
      const live = await agentGet(orchestrator.agentName, { signal, env });
      if (live?.result?.agent) return state;
    } catch {
      // Historical state is not active when Herdr no longer resolves its agent.
    }
  }
  return null;
}

export async function doctor({ cwd = process.cwd(), root = PACKAGE_ROOT, signal } = {}) {
  const commands = {};
  for (const command of ["git", "herdr", "pi"]) commands[command] = await commandExists(command, { cwd, signal });
  let resources;
  let packageReady = true;
  let packageError;
  let orchestratorLaunchMode;
  try {
    resources = assertPackageReady(root);
    orchestratorLaunchMode = resolveLaunchMode(await loadConfig(root));
  } catch (error) {
    packageReady = false;
    packageError = error instanceof Error ? error.message : String(error);
  }
  const versions = {};
  for (const command of ["herdr", "pi"]) {
    if (!commands[command]) continue;
    const result = await runProcess(command, ["--version"], { cwd, signal, timeoutMs: 5_000 });
    // Some Pi releases call process.exit() immediately after console.log(), so
    // the version text can be lost when stdout is a pipe. Presence is still
    // authoritative because commandExists() observed a successful exit.
    versions[command] = result.stdout.trim() || result.stderr.trim() || "installed";
  }
  return {
    ok: Object.values(commands).every(Boolean) && packageReady,
    commands,
    versions,
    packageReady,
    packageError,
    resources,
    orchestratorLaunchMode,
    herdrContext: process.env.HERDR_ENV === "1",
  };
}

export async function preflight({ repository = process.cwd(), signal } = {}) {
  const snapshot = await gitSnapshot(repository, { signal });
  return { ok: snapshot.clean && Boolean(snapshot.branch), ...snapshot };
}

export async function startWorkflow({
  repository = process.cwd(),
  task,
  launchMode,
  adoption,
  approved = false,
  focus = true,
  root = PACKAGE_ROOT,
  env = process.env,
  signal,
  stateOptions = {},
} = {}) {
  assertApproved(approved, "Starting a workflow");
  assertHerdrContext(env);
  assertWorkflowStartAuthority(env);
  if (typeof task !== "string" || !task.trim()) throw new Error("A non-empty task is required.");
  const config = await loadConfig(root, env);
  const mode = resolveLaunchMode(config, launchMode);
  assertPackageReady(root);
  const snapshot = await assertCleanSnapshot(repository, { signal });
  const normalizedTask = task.trim();
  const existing = await reusableWorkflow(snapshot, normalizedTask, { signal, env, stateOptions });
  if (existing) {
    const orchestrator = existing.roles.orchestrator;
    return {
      ok: true,
      reused: true,
      runId: existing.id,
      project: existing.project,
      workspaceId: orchestrator.workspaceId,
      paneId: orchestrator.paneId,
      agentName: orchestrator.agentName,
    };
  }
  const project = basename(snapshot.root);
  const id = createRunId();
  const name = agentName(project, "orchestrator", id);
  const state = {
    schemaVersion: 1,
    id,
    createdAt: now(),
    packageRoot: root,
    project,
    task: normalizedTask,
    launchMode: mode,
    ownsWorkspace: mode === "isolated",
    repository: snapshot,
    roles: {},
    worktree: null,
    roleWorktrees: {},
  };

  if (mode === "adopt-current") {
    if (!adoption || typeof adoption !== "object") {
      throw new Error("Adopting the current Pi session requires an extension-owned runtime snapshot.");
    }
    if (!adoption.sessionId || !adoption.workspaceId || !adoption.paneId) {
      throw new Error("Adopting the current Pi session requires session, workspace, and pane identity.");
    }
    if (adoption.workspaceId !== env.HERDR_WORKSPACE_ID || adoption.paneId !== env.HERDR_PANE_ID) {
      throw new Error("Adoption identity does not match the calling Herdr workspace and pane.");
    }
    state.roles.orchestrator = {
      workspaceId: adoption.workspaceId,
      paneId: adoption.paneId,
      agentName: name,
      cwd: snapshot.root,
      adopted: true,
      ownsWorkspace: false,
      startedAt: now(),
      status: "activating",
    };
    state.activation = {
      status: "activating",
      sessionId: adoption.sessionId,
      workspaceId: adoption.workspaceId,
      paneId: adoption.paneId,
      original: adoption.original ?? {},
      target: {
        agentName: name,
        workspaceLabel: workspaceLabel(project, "orchestrator", config.workspaceSeparator),
        sessionName: `${project} · orchestrator`,
        provider: config.provider,
        model: config.roles.orchestrator.model,
        thinking: config.roles.orchestrator.thinking,
        tools: [...config.roles.orchestrator.tools],
      },
    };
    await writeState(state, stateOptions);
    return {
      ok: true,
      runId: id,
      project,
      launchMode: mode,
      adoptionPending: true,
      workspaceId: adoption.workspaceId,
      paneId: adoption.paneId,
      agentName: name,
      activation: state.activation,
      initialPrompt: orchestratorInitialPrompt(state),
    };
  }

  const runtimeDir = runtimeDirectory(id, "orchestrator", stateOptions);
  await mkdir(runtimeDir, { recursive: true });
  await writeState(state, stateOptions);
  let created;
  try {
    created = await createWorkspace({
      cwd: snapshot.root,
      label: workspaceLabel(project, "orchestrator", config.workspaceSeparator),
      env: workflowEnv(state, "orchestrator", snapshot.root, root, config),
      focus,
    }, { signal, env });
  } catch (error) {
    state.roles.orchestrator = {
      agentName: name,
      cwd: snapshot.root,
      status: "workspace_create_failed",
      failedAt: now(),
      error: error instanceof Error ? error.message : String(error),
    };
    await writeState(state, stateOptions);
    throw error;
  }
  state.roles.orchestrator = roleRecord(created.response, created.workspaceId, created.paneId, name, snapshot.root);
  await writeState(state, stateOptions);

  try {
    const started = await startPiAgent({
      name,
      paneId: created.paneId,
      args: roleArgs({ role: "orchestrator", agentName: name, root, config, sessionDir: runtimeDir }),
      timeoutMs: config.agentStartTimeoutMs,
    }, { signal, env });
    state.roles.orchestrator.agentStartResponse = started;
    await agentPrompt(name, orchestratorInitialPrompt(state), { wait: false, signal, env });
    state.roles.orchestrator.promptedAt = now();
    await writeState(state, stateOptions);
  } catch (error) {
    state.roles.orchestrator.status = "start_failed";
    state.roles.orchestrator.error = error instanceof Error ? error.message : String(error);
    await writeState(state, stateOptions);
    throw error;
  }

  return { ok: true, runId: id, project, launchMode: mode, workspaceId: created.workspaceId, paneId: created.paneId, agentName: name };
}

export async function activateAdoptedWorkflow({ runId, env = process.env, stateOptions = {} } = {}) {
  const id = resolveRunId(runId, env);
  const state = await readState(id, stateOptions);
  if (state.launchMode !== "adopt-current" || state.activation?.status !== "activating") {
    throw new Error(`Workflow '${id}' is not awaiting adoption activation.`);
  }
  state.activation.status = "active";
  state.activation.activatedAt = now();
  state.roles.orchestrator.status = "running";
  state.roles.orchestrator.activatedAt = state.activation.activatedAt;
  await writeState(state, stateOptions);
  return state;
}

export async function failAdoptedWorkflow({ runId, error, env = process.env, stateOptions = {} } = {}) {
  const id = resolveRunId(runId, env);
  const state = await readState(id, stateOptions);
  if (state.launchMode !== "adopt-current") throw new Error(`Workflow '${id}' is not adopted.`);
  const message = error instanceof Error ? error.message : String(error);
  state.activation.status = "failed";
  state.activation.failedAt = now();
  state.activation.error = message;
  state.roles.orchestrator.status = "start_failed";
  state.roles.orchestrator.failedAt = state.activation.failedAt;
  state.roles.orchestrator.error = message;
  await writeState(state, stateOptions);
  return state;
}

export async function finishWorkflow({ runId, env = process.env, stateOptions = {} } = {}) {
  assertHerdrContext(env);
  const id = resolveRunId(runId, env);
  const state = await readState(id, stateOptions);
  assertOrchestratorAuthority(state, env);
  if (!["running", "finishing"].includes(state.roles.orchestrator?.status)) {
    throw new Error(`Workflow '${id}' cannot finish from Orchestrator state '${state.roles.orchestrator?.status ?? "missing"}'.`);
  }
  const finishingAt = now();
  state.roles.orchestrator.status = "finishing";
  state.roles.orchestrator.finishingAt = finishingAt;
  if (state.activation) {
    state.activation.status = "finishing";
    state.activation.finishingAt = finishingAt;
  }
  await writeState(state, stateOptions);
  return {
    ok: true,
    runId: id,
    launchMode: state.launchMode ?? "isolated",
    finishPending: true,
    instruction: "Write the complete final workflow report now. Completion and runtime restoration occur after this turn settles.",
  };
}

export async function completeWorkflow({ runId, restoration, env = process.env, stateOptions = {} } = {}) {
  const id = resolveRunId(runId, env);
  const state = await readState(id, stateOptions);
  const completedAt = now();
  state.roles.orchestrator.status = "completed";
  state.roles.orchestrator.completedAt = completedAt;
  if (state.activation) {
    state.activation.status = restoration?.ok === false ? "restore_failed" : "restored";
    state.activation.restoredAt = completedAt;
    if (restoration?.errors?.length) state.activation.restoreErrors = restoration.errors;
  }
  await writeState(state, stateOptions);
  return state;
}

export async function findAdoptedWorkflow({ sessionId, paneId, stateOptions = {} } = {}) {
  if (!sessionId || !paneId) return null;
  const states = await listStates(stateOptions);
  return states.find((state) => state.launchMode === "adopt-current"
    && state.activation?.sessionId === sessionId
    && state.activation?.paneId === paneId
    && ["active", "finishing"].includes(state.activation?.status)) ?? null;
}

async function ensureDetachedRoleWorktree(state, role, { signal, stateOptions }) {
  state.roleWorktrees ??= {};
  const preserved = state.roleWorktrees[role];
  if (preserved?.path) {
    const snapshot = await gitSnapshot(preserved.path, { signal });
    if (snapshot.head !== state.repository.head) {
      throw new Error(`Preserved ${role} worktree HEAD changed from the approved base.`);
    }
    if (role !== "reviewer" && !snapshot.clean) {
      throw new Error(`Preserved ${role} worktree is unexpectedly dirty.`);
    }
    return path.resolve(preserved.path);
  }
  const worktreePath = worktreePathFor({
    repository: state.repository.root,
    project: state.project,
    task: state.task,
    runId: state.id,
    role,
  }, { env: stateOptions.env, home: stateOptions.home });
  await mkdir(path.dirname(worktreePath), { recursive: true });
  const worktree = await createDetachedWorktree({
    root: state.repository.root,
    base: state.repository.head,
    worktreePath,
  }, { signal });
  state.roleWorktrees[role] = { ...worktree, role, createdAt: now() };
  await writeState(state, stateOptions);
  return worktree.path;
}

async function refreshReviewerSnapshot(state, { signal, stateOptions }) {
  const builder = state.roles.builder;
  if (!builder?.cwd || builder.status === "closed") throw new Error("Builder must remain available for review.");
  const reviewerPath = await ensureDetachedRoleWorktree(state, "reviewer", { signal, stateOptions });
  const snapshot = await syncReviewSnapshot({
    builderRoot: builder.cwd,
    reviewerRoot: reviewerPath,
    previousEntries: state.reviewSnapshot?.entries ?? [],
  }, { signal });
  state.reviewSnapshot = { ...snapshot, builderRoot: builder.cwd, reviewerRoot: reviewerPath, syncedAt: now() };
  await writeState(state, stateOptions);
  return reviewerPath;
}

export async function startRole({
  runId,
  role,
  prompt,
  taskBranch,
  approved = false,
  focus = false,
  root = PACKAGE_ROOT,
  env = process.env,
  signal,
  stateOptions = {},
} = {}) {
  assertApproved(approved, `Starting role '${role ?? "unknown"}'`);
  assertHerdrContext(env);
  if (!["scout", "builder", "reviewer"].includes(role)) throw new Error(`Unsupported main role: ${role}`);
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("A role assignment prompt is required.");
  const id = resolveRunId(runId, env);
  const state = await readState(id, stateOptions);
  assertOrchestratorAuthority(state, env);
  if (state.roles[role] && state.roles[role].status !== "closed") throw new Error(`Role '${role}' already exists for this workflow.`);
  const config = await loadConfig(root, env);
  assertPackageReady(root);
  const name = agentName(state.project, role, id);
  let created;
  let cwd;

  if (role === "builder") {
    await assertSnapshotUnchanged(state.repository, { signal });
    if (state.worktree?.path) {
      cwd = path.resolve(state.worktree.path);
      const existing = await gitSnapshot(cwd, { signal });
      if (existing.branch !== state.worktree.branch) {
        throw new Error(`Preserved Builder worktree branch changed from '${state.worktree.branch}' to '${existing.branch ?? "detached"}'.`);
      }
      if (taskBranch && taskBranch !== state.worktree.branch) {
        throw new Error(`This workflow already owns Builder branch '${state.worktree.branch}', not '${taskBranch}'.`);
      }
    } else {
      const branch = taskBranch || defaultTaskBranch(state.task, id);
      await validateBranch(state.repository.root, branch, { signal });
      cwd = worktreePathFor({
        repository: state.repository.root,
        project: state.project,
        task: state.task,
        runId: id,
      }, { env: stateOptions.env, home: stateOptions.home });
      await mkdir(path.dirname(cwd), { recursive: true });
      const worktree = await createLinkedWorktree({
        root: state.repository.root,
        branch,
        base: state.repository.head,
        worktreePath: cwd,
      }, { signal });
      state.worktree = { ...worktree, createdAt: now() };
      // Persist ownership before asking Herdr to create a workspace. If the
      // later operation fails, the worktree remains discoverable and recoverable.
      await writeState(state, stateOptions);
    }
  } else if (role === "reviewer") {
    const builder = state.roles.builder;
    if (!builder || builder.status === "closed") throw new Error("Builder must exist before Reviewer starts.");
    const builderInfo = await agentGet(builder.agentName, { signal, env });
    const builderStatus = builderInfo?.result?.agent?.agent_status;
    if (!["idle", "done"].includes(builderStatus)) {
      throw new Error(`Builder must be idle or done before review; current state is '${builderStatus}'.`);
    }
    cwd = await refreshReviewerSnapshot(state, { signal, stateOptions });
  } else {
    await assertSnapshotUnchanged(state.repository, { signal });
    cwd = await ensureDetachedRoleWorktree(state, "scout", { signal, stateOptions });
  }

  const label = workspaceLabel(state.project, role, config.workspaceSeparator);
  try {
    const orchestratorWorkspaceId = state.roles.orchestrator?.workspaceId;
    if (!orchestratorWorkspaceId) throw new Error("The workflow has no owning Orchestrator workspace.");
    created = await openWorktreeWorkspace({
      sourceWorkspaceId: orchestratorWorkspaceId,
      cwd,
      label,
      env: workflowEnv(state, role, cwd, root, config),
      focus,
    }, { signal, env });
  } catch (error) {
    state.roles[role] = {
      agentName: name,
      cwd,
      status: "workspace_create_failed",
      failedAt: now(),
      error: error instanceof Error ? error.message : String(error),
    };
    await writeState(state, stateOptions);
    throw error;
  }

  const runtimeDir = runtimeDirectory(id, role, stateOptions);
  await mkdir(runtimeDir, { recursive: true });
  state.roles[role] = roleRecord(created.response, created.workspaceId, created.paneId, name, cwd);
  await writeState(state, stateOptions);
  try {
    const started = await startPiAgent({
      name,
      paneId: created.paneId,
      args: roleArgs({ role, agentName: name, root, config, sessionDir: runtimeDir }),
      timeoutMs: config.agentStartTimeoutMs,
    }, { signal, env });
    state.roles[role].agentStartResponse = started;
    await agentPrompt(name, prompt.trim(), { wait: false, signal, env });
    state.roles[role].promptedAt = now();
    await writeState(state, stateOptions);
  } catch (error) {
    state.roles[role].status = "start_failed";
    state.roles[role].error = error instanceof Error ? error.message : String(error);
    await writeState(state, stateOptions);
    throw error;
  }
  return { ok: true, runId: id, role, workspaceId: created.workspaceId, paneId: created.paneId, agentName: name, cwd };
}

async function roleTarget(runId, role, env, stateOptions) {
  const id = resolveRunId(runId, env);
  const state = await readState(id, stateOptions);
  assertOrchestratorAuthority(state, env);
  const record = state.roles[role];
  if (!record || record.status === "closed") throw new Error(`Role '${role}' is not active.`);
  if (!record.workspaceId || !record.paneId || !record.agentName) {
    throw new Error(`Role '${role}' never reached an active workspace; inspect workflow status for recovery details.`);
  }
  return { id, state, record };
}

export async function promptRole({ runId, role, prompt, wait = true, timeoutMs, env = process.env, signal, stateOptions = {} } = {}) {
  assertHerdrContext(env);
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("A non-empty prompt is required.");
  const { state, record } = await roleTarget(runId, role, env, stateOptions);
  const info = await agentGet(record.agentName, { signal, env });
  const status = info?.result?.agent?.agent_status;
  if (status === "working") throw new Error(`Role '${role}' is already working.`);
  if (role === "reviewer") {
    const builder = state.roles.builder;
    const builderInfo = await agentGet(builder.agentName, { signal, env });
    const builderStatus = builderInfo?.result?.agent?.agent_status;
    if (!["idle", "done"].includes(builderStatus)) {
      throw new Error(`Builder must be idle or done before refreshing review; current state is '${builderStatus}'.`);
    }
    await refreshReviewerSnapshot(state, { signal, stateOptions });
  }
  return agentPrompt(record.agentName, prompt.trim(), { wait, timeoutMs, signal, env });
}

export async function waitRole({ runId, role, timeoutMs = 1_200_000, env = process.env, signal, stateOptions = {} } = {}) {
  assertHerdrContext(env);
  const { record } = await roleTarget(runId, role, env, stateOptions);
  return agentWait(record.agentName, timeoutMs, { signal, env });
}

export async function readRole({ runId, role, lines = 160, env = process.env, signal, stateOptions = {} } = {}) {
  assertHerdrContext(env);
  const { record } = await roleTarget(runId, role, env, stateOptions);
  return agentRead(record.agentName, lines, { signal, env });
}

export async function statusWorkflow({ runId, env = process.env, signal, stateOptions = {} } = {}) {
  assertHerdrContext(env);
  const id = resolveRunId(runId, env);
  const state = await readState(id, stateOptions);
  const roles = {};
  for (const [role, record] of Object.entries(state.roles)) {
    if (record.status === "closed") {
      roles[role] = { stored: record };
      continue;
    }
    try {
      roles[role] = { stored: record, live: await agentGet(record.agentName, { signal, env }) };
    } catch (error) {
      roles[role] = { stored: record, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const repositories = { base: await gitSnapshot(state.repository.root, { signal }) };
  if (state.worktree?.path) {
    try {
      repositories.worktree = await gitSnapshot(state.worktree.path, { signal });
    } catch (error) {
      repositories.worktree = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  for (const [role, worktree] of Object.entries(state.roleWorktrees ?? {})) {
    if (!worktree?.path) continue;
    try {
      repositories[role] = await gitSnapshot(worktree.path, { signal });
    } catch (error) {
      repositories[role] = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { ok: true, state, roles, repositories };
}

export async function closeRole({ runId, role, approved = false, env = process.env, signal, stateOptions = {} } = {}) {
  assertApproved(approved, "Closing a role workspace");
  assertHerdrContext(env);
  if (role === "orchestrator") throw new Error("The Orchestrator cannot close its own workspace through this tool.");
  const { state, record } = await roleTarget(runId, role, env, stateOptions);
  await closeWorkspace(record.workspaceId, { signal, env });
  state.roles[role].status = "closed";
  state.roles[role].closedAt = now();
  await writeState(state, stateOptions);
  return {
    ok: true,
    role,
    workspaceId: record.workspaceId,
    worktreePreserved: role === "builder" ? Boolean(state.worktree) : Boolean(state.roleWorktrees?.[role]),
  };
}
