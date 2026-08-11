import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerSubagentCapabilityCeiling,
  type SubagentCapabilityCeilingHandle,
} from "pi-subagents/capability-ceiling";
import { PACKAGE_ROOT, loadConfig } from "../src/config.mjs";
import { decideToolCall } from "../src/policy.mjs";
import autoInspectors from "./auto-inspectors.ts";

const READ_ONLY_SUBAGENTS = [
  "herdr-workflow.advisor",
  "herdr-workflow.reviewer",
  "herdr-workflow.scout",
];

const READ_ONLY_SUBAGENT_TOOLS = ["read", "grep", "find", "ls"];

export default function roleGuard(pi: ExtensionAPI) {
  const role = process.env.HERDR_WORKFLOW_ROLE;
  const root = process.env.HERDR_WORKFLOW_ROLE_ROOT;
  if (!role || !root) return;
  // Keep this call here as a compatibility bridge: roles launched by a live
  // pre-upgrade Orchestrator already load role-guard, even though their cached
  // argv does not yet include the standalone auto-inspectors extension.
  autoInspectors(pi);

  let ceiling: SubagentCapabilityCeilingHandle | undefined;
  pi.on("session_start", (_event, ctx) => {
    ceiling?.dispose();
    ceiling = registerSubagentCapabilityCeiling({
      sessionId: ctx.sessionManager.getSessionId(),
      source: `herdr-workflow:${role}`,
      ceiling: {
        allowedAgents: READ_ONLY_SUBAGENTS,
        allowedTools: READ_ONLY_SUBAGENT_TOOLS,
        denyExtensions: true,
      },
    });
  });
  pi.on("session_shutdown", () => {
    ceiling?.dispose();
    ceiling = undefined;
  });

  let policyPromise: Promise<Record<string, unknown>> | undefined;
  const policy = () => {
    policyPromise ??= loadConfig(process.env.HERDR_WORKFLOW_PACKAGE_ROOT || PACKAGE_ROOT)
      .then((config) => config.policy as Record<string, unknown>);
    return policyPromise;
  };

  pi.on("tool_call", async (event, ctx) => {
    const reason = decideToolCall({
      role,
      isChild: process.env.PI_SUBAGENT_CHILD === "1",
      toolName: event.toolName,
      input: event.input as Record<string, unknown>,
      root,
      readRoots: [process.env.HERDR_WORKFLOW_PACKAGE_ROOT || PACKAGE_ROOT],
      cwd: ctx.cwd,
      policy: await policy(),
    });
    if (reason) return { block: true, reason };
  });
}
