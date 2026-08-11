import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createJiti } from "jiti";
import { PACKAGE_ROOT } from "../src/config.mjs";

const NAMES = ["advisor", "reviewer", "scout"];

test("package exposes only bounded read-only nested agent definitions", async () => {
  const manifest = JSON.parse(await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
  assert.deepEqual(manifest.pi.subagents.agents, ["./subagents"]);

  for (const name of NAMES) {
    const source = await readFile(path.join(PACKAGE_ROOT, "subagents", `${name}.md`), "utf8");
    assert.match(source, new RegExp(`name: ${name}\\n`, "u"));
    assert.match(source, /package: herdr-workflow\n/u);
    assert.match(source, /tools: read, grep, find, ls\n/u);
    assert.match(source, /maxSubagentDepth: 0\n/u);
    assert.doesNotMatch(source, /tools:.*\b(?:bash|edit|write)\b/u);
  }
});

test("role guard registers and disposes an enforceable subagent ceiling", async () => {
  const jiti = createJiti(import.meta.url);
  const roleGuard = await jiti.import("../extensions/role-guard.ts", { default: true });
  const capability = await jiti.import("pi-subagents/capability-ceiling");
  const handlers = new Map();
  const pi = { on: (event, handler) => handlers.set(event, handler) };
  const previous = {
    role: process.env.HERDR_WORKFLOW_ROLE,
    root: process.env.HERDR_WORKFLOW_ROLE_ROOT,
  };
  process.env.HERDR_WORKFLOW_ROLE = "builder";
  process.env.HERDR_WORKFLOW_ROLE_ROOT = PACKAGE_ROOT;

  try {
    roleGuard(pi);
    const sessionId = "herdr-workflow-capability-test";
    handlers.get("session_start")({}, { sessionManager: { getSessionId: () => sessionId } });
    const ceiling = capability.resolveSubagentCapabilityCeiling(sessionId);
    assert.deepEqual(ceiling.allowedAgents, [
      "herdr-workflow.advisor",
      "herdr-workflow.reviewer",
      "herdr-workflow.scout",
    ]);
    assert.deepEqual(ceiling.allowedTools, ["find", "grep", "ls", "read"]);
    assert.equal(ceiling.denyExtensions, true);

    handlers.get("session_shutdown")();
    assert.equal(capability.resolveSubagentCapabilityCeiling(sessionId), undefined);
  } finally {
    if (previous.role === undefined) delete process.env.HERDR_WORKFLOW_ROLE;
    else process.env.HERDR_WORKFLOW_ROLE = previous.role;
    if (previous.root === undefined) delete process.env.HERDR_WORKFLOW_ROLE_ROOT;
    else process.env.HERDR_WORKFLOW_ROLE_ROOT = previous.root;
  }
});
