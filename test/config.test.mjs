import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadConfig, PACKAGE_ROOT, resolveLaunchMode, roleArgs } from "../src/config.mjs";

test("configuration supports machine-local provider and model overrides", async () => {
  const config = await loadConfig(PACKAGE_ROOT, {
    HERDR_WORKFLOW_PROVIDER: "fixture-provider",
    HERDR_WORKFLOW_BUILDER_MODEL: "fixture-model",
  });
  assert.equal(config.provider, "fixture-provider");
  assert.equal(config.roles.builder.model, "fixture-model");
  assert.equal(config.roles.reviewer.model, "gpt-5.6-luna");
  assert.equal(config.orchestratorLaunchMode, "isolated");
});

test("Orchestrator launch mode remains isolated until explicitly enabled", async () => {
  const config = await loadConfig(PACKAGE_ROOT, { HERDR_WORKFLOW_LAUNCH_MODE: "adopt-current" });
  assert.equal(resolveLaunchMode(config), "adopt-current");
  assert.equal(resolveLaunchMode(config, "isolated"), "isolated");
  assert.throws(() => resolveLaunchMode(config, "unsupported"), /Unsupported Orchestrator launch mode/u);
});

test("role arguments resolve package resources without a fixed home directory", async () => {
  const config = await loadConfig();
  const args = roleArgs({
    role: "orchestrator",
    agentName: "fixture-orchestrator",
    config,
    sessionDir: "/tmp/herdr-workflow-fixture-session",
  });
  assert.ok(args.includes(path.join(PACKAGE_ROOT, "extensions", "herdr-workflow.ts")));
  assert.ok(args.includes(path.join(PACKAGE_ROOT, "extensions", "role-guard.ts")));
  assert.ok(args.includes(path.join(PACKAGE_ROOT, "extensions", "auto-inspectors.ts")));
  assert.ok(args.includes(path.join(PACKAGE_ROOT, "node_modules", "pi-subagents", "index.ts")));
  assert.ok(args.includes("--no-context-files"));
  assert.ok(args.includes("--no-approve"));
  assert.ok(!args.some((value) => value.includes("~") || value.includes("${HOME}")));
});
