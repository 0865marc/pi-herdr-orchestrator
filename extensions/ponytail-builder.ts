import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import ponytailInstructions from "../node_modules/@dietrichgebert/ponytail/hooks/ponytail-instructions.js";

const { getPonytailInstructions } = ponytailInstructions as {
  getPonytailInstructions(mode: "full"): string;
};

const WORKFLOW_OVERRIDE = [
  "## Workflow role override",
  "Ponytail is fixed to full for this Builder session; mode and global configuration commands are unavailable.",
  "The approved plan, role authority, repository rules, and required validation remain authoritative.",
  "Evaluate Orchestrator-proposed parallel support candidates as part of the workflow; keep useful read-only delegation, but do not launch children whose overhead exceeds their value.",
].join("\n");

/**
 * Apply Ponytail's full implementation guidance without exposing its global
 * configuration commands inside a workflow role.
 */
export default function registerBuilderPonytail(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const base = event?.systemPrompt ? `${event.systemPrompt}\n\n` : "";
    return { systemPrompt: `${base}${getPonytailInstructions("full")}\n\n${WORKFLOW_OVERRIDE}` };
  });
}
