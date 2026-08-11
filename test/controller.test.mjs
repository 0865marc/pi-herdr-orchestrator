import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  activateAdoptedWorkflow,
  assertWorkflowStartAuthority,
  completeWorkflow,
  findAdoptedWorkflow,
  finishWorkflow,
  orchestratorInitialPrompt,
  startWorkflow,
} from "../src/controller.mjs";
import { readState } from "../src/state.mjs";

const exec = promisify(execFile);

async function cleanRepository() {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-adopt-repo-"));
  await exec("git", ["init", "-b", "main"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await exec("git", ["config", "user.name", "Workflow Test"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "fixture\n");
  await exec("git", ["add", "README.md"], { cwd: root });
  await exec("git", ["commit", "-m", "fixture"], { cwd: root });
  return root;
}

test("active workflow roles cannot recursively bootstrap", () => {
  assert.throws(() => assertWorkflowStartAuthority({ HERDR_WORKFLOW_ROLE: "orchestrator", HERDR_WORKFLOW_RUN_ID: "run-1" }), /cannot start another workflow/u);
  assert.doesNotThrow(() => assertWorkflowStartAuthority({ HERDR_ENV: "1" }));
});

test("Orchestrator initial prompt identifies the existing run", () => {
  const prompt = orchestratorInitialPrompt({
    id: "run-1",
    task: "Implement the feature",
    repository: { branch: "main", head: "abc123" },
  });
  assert.match(prompt, /already bootstrapped/u);
  assert.match(prompt, /Do not call herdr_workflow\.start/u);
  assert.match(prompt, /run-1/u);
  assert.match(prompt, /Implement the feature/u);
});

test("adopt-current records the calling Pi without creating another workspace", async () => {
  const repository = await cleanRepository();
  const stateRoot = await mkdtemp(path.join(tmpdir(), "herdr-adopt-state-"));
  const env = {
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: "/tmp/fixture.sock",
    HERDR_WORKSPACE_ID: "w-current",
    HERDR_PANE_ID: "w-current:p1",
  };
  const result = await startWorkflow({
    repository,
    task: "Implement a long feature",
    launchMode: "adopt-current",
    adoption: {
      sessionId: "session-1",
      workspaceId: "w-current",
      paneId: "w-current:p1",
      original: {
        tools: ["read"],
        model: { provider: "fixture", id: "model" },
        thinking: "medium",
        workspaceLabel: "project",
        agentName: null,
        environment: {},
      },
    },
    approved: true,
    env,
    stateOptions: { root: stateRoot },
  });
  assert.equal(result.launchMode, "adopt-current");
  assert.equal(result.adoptionPending, true);
  assert.equal(result.workspaceId, "w-current");
  const stored = await readState(result.runId, { root: stateRoot });
  assert.equal(stored.ownsWorkspace, false);
  assert.equal(stored.roles.orchestrator.status, "activating");
  assert.equal(stored.activation.sessionId, "session-1");

  const active = await activateAdoptedWorkflow({ runId: result.runId, env, stateOptions: { root: stateRoot } });
  assert.equal(active.activation.status, "active");
  assert.equal(active.roles.orchestrator.status, "running");
  assert.equal((await findAdoptedWorkflow({ sessionId: "session-1", paneId: "w-current:p1", stateOptions: { root: stateRoot } })).id, result.runId);

  const authorityEnv = { ...env, HERDR_WORKFLOW_ROLE: "orchestrator", HERDR_WORKFLOW_RUN_ID: result.runId };
  const finishing = await finishWorkflow({ runId: result.runId, env: authorityEnv, stateOptions: { root: stateRoot } });
  assert.equal(finishing.finishPending, true);
  await completeWorkflow({ runId: result.runId, restoration: { ok: true, errors: [] }, env, stateOptions: { root: stateRoot } });
  const completed = await readState(result.runId, { root: stateRoot });
  assert.equal(completed.roles.orchestrator.status, "completed");
  assert.equal(completed.activation.status, "restored");
  assert.equal(await findAdoptedWorkflow({ sessionId: "session-1", paneId: "w-current:p1", stateOptions: { root: stateRoot } }), null);
});

test("adopt-current rejects a mismatched caller identity", async () => {
  const repository = await cleanRepository();
  const stateRoot = await mkdtemp(path.join(tmpdir(), "herdr-adopt-mismatch-"));
  await assert.rejects(startWorkflow({
    repository,
    task: "Mismatched adoption",
    launchMode: "adopt-current",
    adoption: { sessionId: "session-1", workspaceId: "w-other", paneId: "w-other:p1" },
    approved: true,
    env: {
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: "/tmp/fixture.sock",
      HERDR_WORKSPACE_ID: "w-current",
      HERDR_PANE_ID: "w-current:p1",
    },
    stateOptions: { root: stateRoot },
  }), /does not match/u);
});
