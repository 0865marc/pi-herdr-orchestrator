import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerSubagentCapabilityCeiling,
  type SubagentCapabilityCeilingHandle,
} from "pi-subagents/capability-ceiling";
import { PACKAGE_ROOT, loadConfig } from "../src/config.mjs";
import { decideToolCall } from "../src/policy.mjs";
import { readState } from "../src/state.mjs";
import { writerWaveIsActive } from "../src/writer-wave.mjs";
import autoInspectors from "./auto-inspectors.ts";

const READ_ONLY_SUBAGENTS = [
  "pi-herdr-orchestrator.advisor",
  "pi-herdr-orchestrator.reviewer",
  "pi-herdr-orchestrator.scout",
];

const READ_ONLY_SUBAGENT_TOOLS = ["read", "grep", "find", "ls"];

export default function roleGuard(pi: ExtensionAPI) {
  const role = process.env.PI_HERDR_ORCHESTRATOR_ROLE;
  const root = process.env.PI_HERDR_ORCHESTRATOR_ROLE_ROOT;
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
      source: `pi-herdr-orchestrator:${role}`,
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
    policyPromise ??= loadConfig(process.env.PI_HERDR_ORCHESTRATOR_PACKAGE_ROOT || PACKAGE_ROOT)
      .then((config) => config.policy as Record<string, unknown>);
    return policyPromise;
  };

  pi.on("tool_call", async (event, ctx) => {
    let activeWriterWave = false;
    if (role === "builder" && ["bash", "edit", "write"].includes(event.toolName)) {
      const runId = process.env.PI_HERDR_ORCHESTRATOR_RUN_ID;
      if (runId) {
        try {
          activeWriterWave = writerWaveIsActive(await readState(runId));
        } catch {
          activeWriterWave = true;
        }
      }
    }
    const reason = decideToolCall({
      role,
      isChild: process.env.PI_SUBAGENT_CHILD === "1",
      writerWaveActive: activeWriterWave,
      toolName: event.toolName,
      input: event.input as Record<string, unknown>,
      root,
      readRoots: [process.env.PI_HERDR_ORCHESTRATOR_PACKAGE_ROOT || PACKAGE_ROOT],
      cwd: ctx.cwd,
      policy: await policy(),
    });
    if (reason) return { block: true, reason };
  });
}
