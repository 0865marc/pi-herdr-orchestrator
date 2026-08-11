import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { dataRoot, listStates, readState, stateRoot, updateState, worktreePathFor, writeState } from "../src/state.mjs";

test("state and worktree paths honor XDG directories", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "pi-herdr-orchestrator-state-"));
  const env = { XDG_STATE_HOME: path.join(base, "state"), XDG_DATA_HOME: path.join(base, "data") };
  assert.equal(stateRoot(env, "/unused"), path.join(base, "state", "pi-herdr-orchestrator", "runs"));
  assert.equal(dataRoot(env, "/unused"), path.join(base, "data", "pi-herdr-orchestrator"));
  const worktree = worktreePathFor({ repository: "/repo/example", project: "example", task: "Long task", runId: "run-1" }, { env, home: "/unused" });
  assert.ok(worktree.startsWith(path.join(base, "data", "pi-herdr-orchestrator", "worktrees")));

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

test("concurrent state writers preserve disjoint Builder and Orchestrator updates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-herdr-orchestrator-state-merge-"));
  const initial = { schemaVersion: 1, id: "run-merge", roles: { orchestrator: { status: "running" } } };
  await writeState(initial, { root });
  const builderView = await readState(initial.id, { root });
  const orchestratorView = await readState(initial.id, { root });
  builderView.parallelImplementation = { waves: [{ id: "wave-1", status: "running" }] };
  orchestratorView.roles.scout = { status: "running" };
  await Promise.all([
    writeState(builderView, { root }),
    writeState(orchestratorView, { root }),
  ]);
  const merged = await readState(initial.id, { root });
  assert.equal(merged.parallelImplementation.waves[0].status, "running");
  assert.equal(merged.roles.scout.status, "running");
});

test("concurrent state writers reject conflicting updates to the same field", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-herdr-orchestrator-state-conflict-"));
  const initial = { schemaVersion: 1, id: "run-conflict", roles: { builder: { status: "running" } } };
  await writeState(initial, { root });
  const left = await readState(initial.id, { root });
  const right = await readState(initial.id, { root });
  left.roles.builder.status = "closed";
  right.roles.builder.status = "start_failed";
  await writeState(left, { root });
  await assert.rejects(writeState(right, { root }), /Concurrent workflow state conflict/u);
});

test("atomic state reservations cannot both close Builder and launch a Writer wave", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-herdr-orchestrator-state-reserve-"));
  const initial = {
    schemaVersion: 1,
    id: "run-reserve",
    roles: { orchestrator: { status: "running" }, builder: { status: "running" } },
  };
  await writeState(initial, { root });
  const [launch, close] = await Promise.allSettled([
    updateState(initial.id, (state) => {
      if (state.roles.builder.status !== "running") throw new Error("Builder is not active");
      state.parallelImplementation = { waves: [{ id: "wave", status: "preparing" }] };
      return state;
    }, { root }),
    updateState(initial.id, (state) => {
      if (state.parallelImplementation?.waves?.some((wave) => wave.status === "preparing")) throw new Error("Writer wave is active");
      state.roles.builder.status = "closing";
      return state;
    }, { root }),
  ]);
  assert.equal([launch, close].filter((result) => result.status === "fulfilled").length, 1);
  const final = await readState(initial.id, { root });
  assert.equal(Boolean(final.parallelImplementation?.waves?.length) && final.roles.builder.status === "closing", false);
});
