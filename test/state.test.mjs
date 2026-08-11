import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { dataRoot, listStates, readState, stateRoot, worktreePathFor, writeState } from "../src/state.mjs";

test("state and worktree paths honor XDG directories", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "herdr-workflow-state-"));
  const env = { XDG_STATE_HOME: path.join(base, "state"), XDG_DATA_HOME: path.join(base, "data") };
  assert.equal(stateRoot(env, "/unused"), path.join(base, "state", "herdr-workflow", "runs"));
  assert.equal(dataRoot(env, "/unused"), path.join(base, "data", "herdr-workflow"));
  const worktree = worktreePathFor({ repository: "/repo/example", project: "example", task: "Long task", runId: "run-1" }, { env, home: "/unused" });
  assert.ok(worktree.startsWith(path.join(base, "data", "herdr-workflow", "worktrees")));

  const state = { schemaVersion: 1, id: "run-1", roles: {} };
  const root = stateRoot(env, "/unused");
  await writeState(state, { root });
  assert.deepEqual(await readState("run-1", { root }), state);
  assert.deepEqual(await listStates({ root }), [state]);
});

test("role worktree paths are stable and distinct", () => {
  const input = { repository: "/repo/example", project: "example", task: "Long task", runId: "run-1" };
  const scout = worktreePathFor({ ...input, role: "scout" }, { root: "/state" });
  const reviewer = worktreePathFor({ ...input, role: "reviewer" }, { root: "/state" });
  assert.notEqual(scout, reviewer);
  assert.match(scout, /-scout$/u);
});
