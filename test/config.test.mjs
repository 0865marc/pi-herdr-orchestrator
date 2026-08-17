import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig, packageResources, PACKAGE_ROOT, resolveLaunchMode, roleArgs, writerArgs } from "../src/config.mjs";

test("configuration supports machine-local provider and model overrides", async () => {
  const config = await loadConfig(PACKAGE_ROOT, {
    PI_HERDR_ORCHESTRATOR_PROVIDER: "fixture-provider",
    PI_HERDR_ORCHESTRATOR_BUILDER_MODEL: "fixture-model",
  });
  assert.equal(config.provider, "fixture-provider");
  assert.equal(config.roles.builder.model, "fixture-model");
  assert.equal(config.roles.reviewer.model, "gpt-5.6-luna");
  assert.equal(config.orchestratorLaunchMode, "isolated");
});

test("Orchestrator launch mode remains isolated until explicitly enabled", async () => {
  const config = await loadConfig(PACKAGE_ROOT, { PI_HERDR_ORCHESTRATOR_LAUNCH_MODE: "adopt-current" });
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
    sessionDir: "/tmp/pi-herdr-orchestrator-fixture-session",
  });
  assert.ok(args.includes(path.join(PACKAGE_ROOT, "extensions", "pi-herdr-orchestrator.ts")));
  assert.ok(args.includes(path.join(PACKAGE_ROOT, "extensions", "role-guard.ts")));
  assert.ok(args.includes(path.join(PACKAGE_ROOT, "extensions", "auto-inspectors.ts")));
  assert.ok(args.includes(path.join(PACKAGE_ROOT, "extensions", "ask-user-question.ts")));
  assert.equal(
    packageResources().askUserQuestionPackage,
    path.join(PACKAGE_ROOT, "node_modules", "@juicesharp", "rpiv-ask-user-question", "index.ts"),
  );
  assert.equal(
    packageResources().ponytailInstructions,
    path.join(PACKAGE_ROOT, "node_modules", "@dietrichgebert", "ponytail", "hooks", "ponytail-instructions.js"),
  );
  assert.equal(
    packageResources().ponytailReviewSkill,
    path.join(PACKAGE_ROOT, "node_modules", "@dietrichgebert", "ponytail", "skills", "ponytail-review"),
  );
  assert.ok(args.includes(path.join(PACKAGE_ROOT, "extensions", "role-appearance.ts")));
  assert.ok(args.includes(path.join(PACKAGE_ROOT, "node_modules", "pi-subagents", "index.ts")));
  assert.ok(config.roles.orchestrator.tools.includes("ask_user_question"));
  const builderArgs = roleArgs({ role: "builder", agentName: "fixture-builder", config });
  const reviewerArgs = roleArgs({ role: "reviewer", agentName: "fixture-reviewer", config });
  const scoutArgs = roleArgs({ role: "scout", agentName: "fixture-scout", config });
  const appearanceExtension = path.join(PACKAGE_ROOT, "extensions", "role-appearance.ts");
  assert.ok(builderArgs.includes(appearanceExtension));
  assert.ok(reviewerArgs.includes(appearanceExtension));
  assert.ok(scoutArgs.includes(appearanceExtension));
  const ponytailBuilder = path.join(PACKAGE_ROOT, "extensions", "ponytail-builder.ts");
  const ponytailReview = path.join(PACKAGE_ROOT, "node_modules", "@dietrichgebert", "ponytail", "skills", "ponytail-review");
  assert.ok(!builderArgs.includes(path.join(PACKAGE_ROOT, "extensions", "ask-user-question.ts")));
  assert.ok(!config.roles.builder.tools.includes("ask_user_question"));
  assert.ok(builderArgs.includes(ponytailBuilder));
  assert.ok(builderArgs.includes(path.join(PACKAGE_ROOT, "extensions", "builder-writers.ts")));
  assert.ok(!builderArgs.includes(ponytailReview));
  assert.ok(reviewerArgs.includes(ponytailReview));
  assert.ok(!reviewerArgs.includes(ponytailBuilder));
  assert.ok(!args.includes(ponytailBuilder));
  assert.ok(!args.includes(ponytailReview));
  assert.ok(!scoutArgs.includes(ponytailBuilder));
  assert.ok(!scoutArgs.includes(ponytailReview));
  const isolatedWriterArgs = writerArgs({ agentName: "fixture-writer", config, sessionDir: "/tmp/pi-herdr-writer-session" });
  assert.ok(isolatedWriterArgs.includes(path.join(PACKAGE_ROOT, "extensions", "writer-guard.ts")));
  assert.ok(!isolatedWriterArgs.some((value) => value.includes("pi-subagents")));
  assert.ok(!isolatedWriterArgs.includes("bash"));
  assert.ok(!isolatedWriterArgs.includes("subagent"));
  assert.ok(isolatedWriterArgs.includes("--no-context-files"));
  assert.ok(args.includes("--no-context-files"));
  assert.ok(args.includes("--no-approve"));
  assert.ok(!args.some((value) => value.includes("~") || value.includes("${HOME}")));
});

test("normal Pi does not load Ponytail globally and Context Mode stays design-only", async () => {
  const manifest = JSON.parse(await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
  assert.ok(!manifest.pi.extensions.some((entry) => entry.includes("ponytail")));
  assert.ok(!manifest.pi.skills.some((entry) => entry.includes("ponytail")));
  assert.equal(manifest.dependencies["context-mode"], undefined);
  assert.ok(!manifest.pi.extensions.some((entry) => entry.includes("context-mode")));
  const config = await loadConfig();
  assert.ok(Object.values(config.roles).every((role) => role.tools.every((tool) => !tool.startsWith("ctx_"))));
});
