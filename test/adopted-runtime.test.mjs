import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAdoptedEnvironment,
  modelReference,
  restoreWorkflowEnvironment,
  snapshotWorkflowEnvironment,
} from "../src/adopted-runtime.mjs";

test("adopted runtime environment is reversible", () => {
  const env = { HERDR_WORKFLOW_ROLE: "previous", UNRELATED: "preserved" };
  const original = snapshotWorkflowEnvironment(env);
  applyAdoptedEnvironment({
    id: "run-1",
    packageRoot: "/package",
    repository: { root: "/repo" },
  }, { policy: { maxInspectorPanesPerRole: 2 } }, env);
  assert.equal(env.HERDR_WORKFLOW_ROLE, "orchestrator");
  assert.equal(env.HERDR_WORKFLOW_RUN_ID, "run-1");
  assert.equal(env.HERDR_WORKFLOW_MAX_INSPECTOR_PANES, "2");
  restoreWorkflowEnvironment(original, env);
  assert.equal(env.HERDR_WORKFLOW_ROLE, "previous");
  assert.equal(env.HERDR_WORKFLOW_RUN_ID, undefined);
  assert.equal(env.UNRELATED, "preserved");
});

test("model references contain stable identifiers only", () => {
  assert.deepEqual(modelReference({ provider: "provider", id: "model", apiKey: "secret" }), { provider: "provider", id: "model" });
  assert.equal(modelReference(undefined), null);
});
