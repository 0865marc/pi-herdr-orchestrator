import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  registerSubagentCapabilityCeiling,
  type SubagentCapabilityCeilingHandle,
} from "pi-subagents/capability-ceiling";
import {
  activateAdoptedWorkflow,
  closeRole,
  completeWorkflow,
  doctor,
  failAdoptedWorkflow,
  findAdoptedWorkflow,
  finishWorkflow,
  orchestratorInitialPrompt,
  preflight,
  promptRole,
  readRole,
  startRole,
  startWorkflow,
  statusWorkflow,
  waitRole,
} from "../src/controller.mjs";
import { applyAdoptedEnvironment, modelReference, restoreWorkflowEnvironment, snapshotWorkflowEnvironment } from "../src/adopted-runtime.mjs";
import { loadConfig, PACKAGE_ROOT, resolveLaunchMode } from "../src/config.mjs";
import { agentGet, clearAgentName, renameAgent, renameWorkspace, workspaceGet } from "../src/herdr.mjs";
import { decideToolCall } from "../src/policy.mjs";
import { installAutoInspectors } from "./auto-inspectors.ts";
import { applyRoleAppearance } from "./role-appearance.ts";

const Action = Type.Union([
  Type.Literal("doctor"),
  Type.Literal("preflight"),
  Type.Literal("start"),
  Type.Literal("start_role"),
  Type.Literal("prompt_role"),
  Type.Literal("wait_role"),
  Type.Literal("read_role"),
  Type.Literal("status"),
  Type.Literal("close_role"),
  Type.Literal("finish"),
]);

const Role = Type.Union([Type.Literal("scout"), Type.Literal("builder"), Type.Literal("reviewer")]);

const Parameters = Type.Object({
  action: Action,
  repository: Type.Optional(Type.String()),
  task: Type.Optional(Type.String()),
  runId: Type.Optional(Type.String()),
  role: Type.Optional(Role),
  prompt: Type.Optional(Type.String()),
  taskBranch: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  wait: Type.Optional(Type.Boolean()),
  focus: Type.Optional(Type.Boolean()),
  approved: Type.Optional(Type.Boolean()),
  launchMode: Type.Optional(Type.Union([Type.Literal("isolated"), Type.Literal("adopt-current")])),
});

function requireRole(role: "scout" | "builder" | "reviewer" | undefined) {
  if (!role) throw new Error("This action requires a role.");
  return role;
}

export default function piHerdrOrchestrator(pi: ExtensionAPI) {
  type PendingAdoption = {
    result: any;
    config: any;
    originalModel: any;
    targetModel: any;
  };
  type ActiveRuntime = PendingAdoption & {
    state: any;
    ceiling?: SubagentCapabilityCeilingHandle;
    disposeInspectors?: () => void;
    disposeAppearance?: () => void;
    restoration?: Promise<{ ok: boolean; errors: string[] }>;
    finishing?: boolean;
  };

  let pendingAdoption: PendingAdoption | undefined;
  let activeRuntime: ActiveRuntime | undefined;
  let pendingIsolatedFinish: string | undefined;
  const orchestratorPrompt = readFile(path.join(PACKAGE_ROOT, "roles", "orchestrator.md"), "utf8");

  function requireHerdrIdentity() {
    const workspaceId = process.env.HERDR_WORKSPACE_ID;
    const paneId = process.env.HERDR_PANE_ID;
    if (process.env.HERDR_ENV !== "1" || !workspaceId || !paneId) {
      throw new Error("Adopting the current Pi session requires an interactive Herdr workspace and pane.");
    }
    return { workspaceId, paneId };
  }

  function runtimeTarget(config: any, ctx: any) {
    const roleConfig = config.roles.orchestrator;
    const targetModel = ctx.modelRegistry.find(config.provider, roleConfig.model);
    if (!targetModel) throw new Error(`Configured Orchestrator model is unavailable: ${config.provider}/${roleConfig.model}`);
    const allTools = new Set(pi.getAllTools().map((tool) => tool.name));
    const missingTools = roleConfig.tools.filter((tool: string) => !allTools.has(tool));
    if (missingTools.length) throw new Error(`Current Pi session is missing Orchestrator tools: ${missingTools.join(", ")}`);
    return { targetModel };
  }

  async function adoptionSnapshot(ctx: any, signal: AbortSignal | undefined) {
    const { workspaceId, paneId } = requireHerdrIdentity();
    const [agentResponse, workspaceResponse] = await Promise.all([
      agentGet(paneId, { signal }),
      workspaceGet(workspaceId, { signal }),
    ]);
    const liveAgent = agentResponse?.result?.agent;
    const workspace = workspaceResponse?.result?.workspace;
    if (!liveAgent || liveAgent.pane_id !== paneId || liveAgent.workspace_id !== workspaceId || liveAgent.agent !== "pi") {
      throw new Error(`The calling Herdr pane does not resolve to this live Pi agent: expected ${workspaceId}/${paneId}, received ${liveAgent?.workspace_id ?? "missing"}/${liveAgent?.pane_id ?? "missing"} (${liveAgent?.agent ?? "missing"}).`);
    }
    if (!workspace || workspace.workspace_id !== workspaceId) {
      throw new Error("The calling Herdr workspace could not be resolved for adoption.");
    }
    return {
      sessionId: ctx.sessionManager.getSessionId(),
      workspaceId,
      paneId,
      original: {
        tools: pi.getActiveTools(),
        model: modelReference(ctx.model),
        thinking: pi.getThinkingLevel(),
        sessionName: pi.getSessionName() ?? null,
        workspaceLabel: workspace.label,
        agentName: typeof liveAgent.name === "string" ? liveAgent.name : null,
        environment: snapshotWorkflowEnvironment(),
      },
    };
  }

  async function restoreAdoptedRuntime(runtime: ActiveRuntime | PendingAdoption) {
    const errors: string[] = [];
    const activation = runtime.result.activation;
    const original = activation.original;
    const attempt = async (label: string, operation: () => unknown | Promise<unknown>) => {
      try {
        await operation();
      } catch (error) {
        errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    if ("disposeInspectors" in runtime) runtime.disposeInspectors?.();
    if ("disposeAppearance" in runtime) runtime.disposeAppearance?.();
    if ("ceiling" in runtime) runtime.ceiling?.dispose();
    await attempt("tools", () => pi.setActiveTools(original.tools));
    await attempt("thinking", () => pi.setThinkingLevel(original.thinking));
    if (runtime.originalModel) await attempt("model", async () => {
      if (!await pi.setModel(runtime.originalModel)) throw new Error("original model authentication is unavailable");
    });
    await attempt("session name", () => pi.setSessionName(original.sessionName ?? ""));
    await attempt("agent name", () => original.agentName
      ? renameAgent(activation.paneId, original.agentName)
      : clearAgentName(activation.paneId));
    await attempt("workspace label", () => renameWorkspace(activation.workspaceId, original.workspaceLabel));
    restoreWorkflowEnvironment(original.environment);
    return { ok: errors.length === 0, errors };
  }

  function releaseActiveRuntime(runtime: ActiveRuntime) {
    if (activeRuntime === runtime) activeRuntime = undefined;
    runtime.restoration ??= restoreAdoptedRuntime(runtime);
    return runtime.restoration;
  }

  async function activatePendingAdoption(ctx: any) {
    const pending = pendingAdoption;
    pendingAdoption = undefined;
    if (!pending) return;
    const activation = pending.result.activation;
    const runtime: ActiveRuntime = { ...pending, state: undefined };
    try {
      await renameWorkspace(activation.workspaceId, activation.target.workspaceLabel);
      await renameAgent(activation.paneId, activation.target.agentName);
      if (!await pi.setModel(pending.targetModel)) {
        throw new Error(`No authentication is available for ${activation.target.provider}/${activation.target.model}.`);
      }
      pi.setThinkingLevel(activation.target.thinking);
      pi.setActiveTools(activation.target.tools);
      pi.setSessionName(activation.target.sessionName);
      const storedState = await activateAdoptedWorkflow({ runId: pending.result.runId });
      attachRuntimeControls(runtime, storedState, ctx);
      pi.sendUserMessage(pending.result.initialPrompt);
    } catch (error) {
      await releaseActiveRuntime(runtime);
      await failAdoptedWorkflow({ runId: pending.result.runId, error });
      pi.sendUserMessage(`Workflow adoption failed and the original Pi runtime was restored. Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function attachRuntimeControls(
    runtime: ActiveRuntime,
    storedState: { id: string; repository: { root: string } },
    ctx: Parameters<typeof applyRoleAppearance>[0],
  ) {
    const activation = runtime.result.activation;
    runtime.state = storedState;
    applyAdoptedEnvironment(storedState, runtime.config);
    runtime.disposeAppearance = applyRoleAppearance(ctx);
    runtime.ceiling = registerSubagentCapabilityCeiling({
      sessionId: activation.sessionId,
      source: "pi-herdr-orchestrator:orchestrator",
      ceiling: {
        allowedAgents: ["pi-herdr-orchestrator.advisor", "pi-herdr-orchestrator.reviewer", "pi-herdr-orchestrator.scout"],
        allowedTools: ["read", "grep", "find", "ls"],
        denyExtensions: true,
      },
    });
    activeRuntime = runtime;
    runtime.disposeInspectors = installAutoInspectors(pi, {
      role: "orchestrator",
      runId: storedState.id,
      sourcePaneId: activation.paneId,
      roleRoot: storedState.repository.root,
      maxPanes: runtime.config.policy?.maxInspectorPanesPerRole ?? 3,
      isActive: () => activeRuntime?.state?.id === storedState.id,
    });
  }

  async function rehydrateAdoptedRuntime(ctx: any, storedState: any) {
    const activation = storedState.activation;
    const config = await loadConfig(storedState.packageRoot);
    const targetModel = ctx.modelRegistry.find(activation.target.provider, activation.target.model);
    if (!targetModel) throw new Error(`Configured Orchestrator model is unavailable: ${activation.target.provider}/${activation.target.model}`);
    const originalRef = activation.original.model;
    const originalModel = originalRef ? ctx.modelRegistry.find(originalRef.provider, originalRef.id) : undefined;
    if (originalRef && !originalModel) throw new Error(`Original Pi model is unavailable: ${originalRef.provider}/${originalRef.id}`);
    const allTools = new Set(pi.getAllTools().map((tool) => tool.name));
    const missingTools = activation.target.tools.filter((tool: string) => !allTools.has(tool));
    if (missingTools.length) throw new Error(`Current Pi session is missing Orchestrator tools: ${missingTools.join(", ")}`);
    const runtime: ActiveRuntime = {
      result: {
        runId: storedState.id,
        activation,
        initialPrompt: orchestratorInitialPrompt(storedState),
      },
      config,
      originalModel,
      targetModel,
      state: storedState,
      finishing: activation.status === "finishing",
    };
    try {
      await renameWorkspace(activation.workspaceId, activation.target.workspaceLabel);
      await renameAgent(activation.paneId, activation.target.agentName);
      if (!await pi.setModel(targetModel)) throw new Error("Orchestrator model authentication is unavailable.");
      pi.setThinkingLevel(activation.target.thinking);
      pi.setActiveTools(activation.target.tools);
      pi.setSessionName(activation.target.sessionName);
      attachRuntimeControls(runtime, storedState, ctx);
      if (runtime.finishing) await restoreFinishedAdoption(runtime);
    } catch (error) {
      await releaseActiveRuntime(runtime);
      await failAdoptedWorkflow({ runId: storedState.id, error });
      pi.sendUserMessage(`Workflow recovery failed and the original Pi runtime was restored. Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function restoreFinishedAdoption(runtime: ActiveRuntime) {
    const restoration = await releaseActiveRuntime(runtime);
    await completeWorkflow({ runId: runtime.result.runId, restoration });
  }

  pi.on("before_agent_start", async (event) => {
    if (!activeRuntime) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${await orchestratorPrompt}` };
  });

  pi.on("session_start", async (_event, ctx) => {
    if (pendingAdoption || activeRuntime || process.env.PI_HERDR_ORCHESTRATOR_ROLE) return;
    const paneId = process.env.HERDR_PANE_ID;
    const sessionId = ctx.sessionManager.getSessionId();
    if (!paneId || !sessionId) return;
    const storedState = await findAdoptedWorkflow({ sessionId, paneId });
    if (storedState) await rehydrateAdoptedRuntime(ctx, storedState);
  });

  pi.on("session_shutdown", async () => {
    const runtime = activeRuntime;
    if (runtime) await releaseActiveRuntime(runtime);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!activeRuntime) return;
    const reason = decideToolCall({
      role: "orchestrator",
      toolName: event.toolName,
      input: event.input as Record<string, unknown>,
      root: activeRuntime.state.repository.root,
      readRoots: [PACKAGE_ROOT],
      cwd: ctx.cwd,
      policy: activeRuntime.config.policy,
    });
    if (reason) return { block: true, reason };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (pendingAdoption) {
      await activatePendingAdoption(ctx);
      return;
    }
    if (activeRuntime?.finishing) {
      await restoreFinishedAdoption(activeRuntime);
      return;
    }
    if (pendingIsolatedFinish) {
      const runId = pendingIsolatedFinish;
      pendingIsolatedFinish = undefined;
      await completeWorkflow({ runId, restoration: { ok: true, errors: [] } });
    }
  });

  pi.registerTool({
    name: "pi_herdr_orchestrator",
    label: "Pi Herdr Orchestrator",
    description: "Start and coordinate the portable Pi-first Herdr workflow. Mutating actions require explicit approved=true and are limited by role ownership.",
    parameters: Parameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let result;
      switch (params.action) {
        case "doctor":
          result = await doctor({ cwd: params.repository || ctx.cwd, signal });
          break;
        case "preflight":
          result = await preflight({ repository: params.repository || ctx.cwd, signal });
          break;
        case "start":
          const config = await loadConfig();
          const launchMode = resolveLaunchMode(config, params.launchMode);
          let adoption;
          let target;
          if (launchMode === "adopt-current") {
            if (pendingAdoption || activeRuntime) throw new Error("This Pi session already owns a pending or active workflow adoption.");
            target = runtimeTarget(config, ctx);
            adoption = await adoptionSnapshot(ctx, signal);
          }
          result = await startWorkflow({
            repository: params.repository || ctx.cwd,
            task: params.task,
            launchMode,
            adoption,
            approved: params.approved,
            focus: params.focus ?? true,
            signal,
          });
          if (result.adoptionPending) {
            pendingAdoption = {
              result,
              config,
              originalModel: ctx.model,
              targetModel: target.targetModel,
            };
          }
          break;
        case "start_role":
          result = await startRole({
            runId: params.runId,
            role: requireRole(params.role),
            prompt: params.prompt,
            taskBranch: params.taskBranch,
            approved: params.approved,
            focus: params.focus ?? false,
            signal,
          });
          break;
        case "prompt_role":
          result = await promptRole({
            runId: params.runId,
            role: requireRole(params.role),
            prompt: params.prompt,
            wait: params.wait ?? true,
            timeoutMs: params.timeoutMs,
            signal,
          });
          break;
        case "wait_role":
          result = await waitRole({
            runId: params.runId,
            role: requireRole(params.role),
            timeoutMs: params.timeoutMs,
            signal,
          });
          break;
        case "read_role":
          result = await readRole({ runId: params.runId, role: requireRole(params.role), lines: params.lines, signal });
          break;
        case "status":
          result = await statusWorkflow({ runId: params.runId, signal });
          break;
        case "close_role":
          result = await closeRole({
            runId: params.runId,
            role: requireRole(params.role),
            approved: params.approved,
            signal,
          });
          break;
        case "finish":
          result = await finishWorkflow({ runId: params.runId, signal });
          if (result.launchMode === "adopt-current") {
            if (!activeRuntime || activeRuntime.result.runId !== result.runId) {
              throw new Error("The adopted runtime lease is not active in this Pi session.");
            }
            activeRuntime.finishing = true;
          } else {
            pendingIsolatedFinish = result.runId;
          }
          break;
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
