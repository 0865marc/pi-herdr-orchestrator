import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { installAutoInspectors } from "../extensions/auto-inspectors.ts";

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for asynchronous inspector work.");
}

function splitDetails(calls) {
  return calls
    .filter((args) => args[0] === "pane" && args[1] === "split")
    .map((args) => ({
      paneId: args[args.indexOf("--pane") + 1],
      direction: args[args.indexOf("--direction") + 1],
      ratio: args[args.indexOf("--ratio") + 1],
      noFocus: args.includes("--no-focus"),
    }));
}

test("parallel async subagents each open a child-specific non-focused Herdr inspector", async () => {
  const asyncDir = await mkdtemp(path.join(tmpdir(), "herdr-auto-inspector-"));
  const eventHandlers = new Map();
  const lifecycleHandlers = new Map();
  const calls = [];
  let paneNumber = 1;
  const pi = {
    events: {
      on(name, handler) {
        eventHandlers.set(name, handler);
        return () => eventHandlers.delete(name);
      },
    },
    on(name, handler) {
      lifecycleHandlers.set(name, handler);
    },
    async exec(_command, args) {
      calls.push(args);
      const payload = args[0] === "pane" && args[1] === "split"
        ? { result: { pane: { pane_id: `w-role:p${++paneNumber}` } } }
        : { result: { type: "ok" } };
      return { code: 0, stdout: JSON.stringify(payload), stderr: "" };
    },
  };
  const previous = {
    role: process.env.PI_HERDR_ORCHESTRATOR_ROLE,
    pane: process.env.HERDR_PANE_ID,
    max: process.env.PI_HERDR_ORCHESTRATOR_MAX_INSPECTOR_PANES,
  };
  process.env.PI_HERDR_ORCHESTRATOR_ROLE = "scout";
  process.env.HERDR_PANE_ID = "w-role:p1";
  process.env.PI_HERDR_ORCHESTRATOR_MAX_INSPECTOR_PANES = "3";
  try {
    installAutoInspectors(pi);
    eventHandlers.get("subagent:async-started")({
      id: "run-12345678",
      asyncDir,
      cwd: "/repo",
      agent: "pi-herdr-orchestrator.scout",
      agents: [
        "pi-herdr-orchestrator.scout",
        "pi-herdr-orchestrator.reviewer",
        "pi-herdr-orchestrator.advisor",
      ],
      workflowGraph: {
        nodes: [{
          kind: "parallel-group",
          label: "Parallel group (3)",
          children: [
            { kind: "agent", agent: "pi-herdr-orchestrator.scout", label: "course migration", flatIndex: 0 },
            { kind: "agent", agent: "pi-herdr-orchestrator.reviewer", label: "inference limits", flatIndex: 1 },
            { kind: "agent", agent: "pi-herdr-orchestrator.advisor", label: "admin user flow", flatIndex: 2 },
          ],
        }],
      },
    });
    await waitFor(() => calls.length >= 9);
    assert.deepEqual(calls.map((args) => args.slice(0, 2)), [
      ["pane", "split"], ["pane", "run"], ["pane", "rename"],
      ["pane", "split"], ["pane", "run"], ["pane", "rename"],
      ["pane", "split"], ["pane", "run"], ["pane", "rename"],
    ]);
    assert.ok(calls.filter((args) => args[1] === "split").every((args) => args.includes("--no-focus")));
    assert.deepEqual(splitDetails(calls), [
      { paneId: "w-role:p1", direction: "right", ratio: "0.5", noFocus: true },
      { paneId: "w-role:p2", direction: "down", ratio: "0.5", noFocus: true },
      { paneId: "w-role:p1", direction: "down", ratio: "0.5", noFocus: true },
    ]);
    const runCommands = calls.filter((args) => args[1] === "run").map((args) => args[3]);
    assert.ok(runCommands[0].includes("'--index' '0'"));
    assert.ok(runCommands[1].includes("'--index' '1'"));
    assert.ok(runCommands[2].includes("'--index' '2'"));
    assert.deepEqual(
      calls.filter((args) => args[1] === "rename").map((args) => args[3]),
      ["subagent · course migration", "subagent · inference limits", "subagent · admin user flow"],
    );
    const bindingFile = path.join(asyncDir, "inspectors", "herdr.json");
    let binding;
    await waitFor(async () => {
      try {
        binding = JSON.parse(await readFile(bindingFile, "utf8"));
        return binding.panes?.length === 3;
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    });
    assert.equal(binding.runId, "run-12345678");
    assert.equal(binding.schemaVersion, 2);
    assert.deepEqual(binding.panes.map((pane) => pane.paneId), ["w-role:p2", "w-role:p3", "w-role:p4"]);
    assert.deepEqual(binding.panes.map((pane) => pane.index), [0, 1, 2]);
    assert.deepEqual(binding.panes.map((pane) => pane.label), ["course migration", "inference limits", "admin user flow"]);

    const nextAsyncDir = await mkdtemp(path.join(tmpdir(), "herdr-auto-inspector-next-"));
    eventHandlers.get("subagent:async-complete")({ runId: "run-12345678" });
    eventHandlers.get("subagent:async-started")({
      id: "run-87654321",
      asyncDir: nextAsyncDir,
      cwd: "/repo",
      agent: "pi-herdr-orchestrator.reviewer",
      workflowGraph: {
        nodes: [{
          kind: "step",
          agent: "pi-herdr-orchestrator.reviewer",
          label: "follow-up contract",
          flatIndex: 0,
        }],
      },
    });
    await waitFor(() => calls.length >= 15);
    assert.deepEqual(calls.slice(9, 15).map((args) => args.slice(0, 2)), [
      ["pane", "close"], ["pane", "close"], ["pane", "close"],
      ["pane", "split"], ["pane", "run"], ["pane", "rename"],
    ]);
    assert.equal(calls[14][3], "subagent · follow-up contract");

    const singleAsyncDir = await mkdtemp(path.join(tmpdir(), "herdr-auto-inspector-single-"));
    eventHandlers.get("subagent:async-complete")({ id: "run-87654321" });
    eventHandlers.get("subagent:async-started")({
      id: "run-single",
      asyncDir: singleAsyncDir,
      cwd: "/repo",
      agent: "pi-herdr-orchestrator.advisor",
    });
    await waitFor(() => calls.length >= 19);
    assert.deepEqual(calls.slice(15, 19).map((args) => args.slice(0, 2)), [
      ["pane", "close"], ["pane", "split"], ["pane", "run"], ["pane", "rename"],
    ]);
    assert.ok(!calls[17][3].includes("--index"));
    assert.equal(calls[18][3], "subagent · advisor");
    lifecycleHandlers.get("session_shutdown")();
    assert.equal(eventHandlers.has("subagent:async-started"), false);
    assert.equal(eventHandlers.has("subagent:async-complete"), false);
  } finally {
    if (previous.role === undefined) delete process.env.PI_HERDR_ORCHESTRATOR_ROLE; else process.env.PI_HERDR_ORCHESTRATOR_ROLE = previous.role;
    if (previous.pane === undefined) delete process.env.HERDR_PANE_ID; else process.env.HERDR_PANE_ID = previous.pane;
    if (previous.max === undefined) delete process.env.PI_HERDR_ORCHESTRATOR_MAX_INSPECTOR_PANES; else process.env.PI_HERDR_ORCHESTRATOR_MAX_INSPECTOR_PANES = previous.max;
  }
});

function createTopologyFixture({ failingRunIds = [] } = {}) {
  const eventHandlers = new Map();
  const calls = [];
  const livePanes = new Set(["w-role:p1"]);
  const failingRuns = new Set(failingRunIds);
  let nextPaneNumber = 1;
  const pi = {
    events: {
      on(name, handler) {
        eventHandlers.set(name, handler);
        return () => eventHandlers.delete(name);
      },
    },
    on() {},
    async exec(_command, args) {
      calls.push([...args]);
      const [scope, action] = args;
      if (scope === "pane" && action === "get") {
        const paneId = args[2];
        if (!livePanes.has(paneId)) return { code: 1, stdout: "", stderr: "pane not found" };
        return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: paneId } } }), stderr: "" };
      }
      if (scope === "pane" && action === "split") {
        const paneId = `w-role:p${++nextPaneNumber}`;
        livePanes.add(paneId);
        return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: paneId } } }), stderr: "" };
      }
      if (scope === "pane" && action === "run" && [...failingRuns].some((runId) => args[3].includes(runId))) {
        return { code: 1, stdout: "", stderr: "runner failed" };
      }
      if (scope === "pane" && action === "close") livePanes.delete(args[2]);
      return { code: 0, stdout: JSON.stringify({ result: { type: "ok" } }), stderr: "" };
    },
  };
  return { pi, calls, eventHandlers, livePanes };
}

function installTopologyFixture(fixture, runId, maxPanes = 3) {
  return installAutoInspectors(fixture.pi, {
    role: "scout",
    runId,
    sourcePaneId: "w-role:p1",
    roleRoot: "/repo",
    maxPanes,
  });
}

function emitAsyncStart(fixture, payload) {
  const handler = fixture.eventHandlers.get("subagent:async-started");
  assert.equal(typeof handler, "function");
  if (typeof handler === "function") handler(payload);
}

async function openSingleInspector(fixture, runId) {
  const asyncDir = await mkdtemp(path.join(tmpdir(), `herdr-topology-${runId}-`));
  const expectedRenames = fixture.calls.filter((args) => args[0] === "pane" && args[1] === "rename").length + 1;
  emitAsyncStart(fixture, { id: runId, asyncDir, cwd: "/repo" });
  await waitFor(
    () => fixture.calls.filter((args) => args[0] === "pane" && args[1] === "rename").length === expectedRenames,
  );
  return asyncDir;
}

test("semantic inspector slots survive each default-grid pane closure", async (t) => {
  for (const { name, closedPane, expectedTarget } of [
    { name: "top-right closure", closedPane: "w-role:p2", expectedTarget: "w-role:p3" },
    { name: "bottom-right closure", closedPane: "w-role:p3", expectedTarget: "w-role:p2" },
    { name: "lower-left closure", closedPane: "w-role:p4", expectedTarget: "w-role:p1" },
  ]) {
    await t.test(name, async () => {
      const fixture = createTopologyFixture();
      const dispose = installTopologyFixture(fixture, `slot-${closedPane}`, 6);
      try {
        await openSingleInspector(fixture, `${closedPane}-one`);
        await openSingleInspector(fixture, `${closedPane}-two`);
        await openSingleInspector(fixture, `${closedPane}-three`);
        fixture.livePanes.delete(closedPane);
        await openSingleInspector(fixture, `${closedPane}-replacement`);
        assert.deepEqual(splitDetails(fixture.calls).at(-1), {
          paneId: expectedTarget,
          direction: "down",
          ratio: "0.5",
          noFocus: true,
        });
      } finally {
        dispose();
      }
    });
  }
});

test("failed startup does not consume the selected inspector slot", async () => {
  const fixture = createTopologyFixture({ failingRunIds: ["run-failed"] });
  const dispose = installTopologyFixture(fixture, "failure", 3);
  const failedDir = await mkdtemp(path.join(tmpdir(), "herdr-topology-failed-"));
  try {
    emitAsyncStart(fixture, { id: "run-failed", asyncDir: failedDir, cwd: "/repo" });
    await waitFor(() => fixture.calls.some((args) => args[0] === "pane" && args[1] === "close" && args[2] === "w-role:p2"));
    await openSingleInspector(fixture, "run-next");
    assert.deepEqual(splitDetails(fixture.calls).slice(-2), [
      { paneId: "w-role:p1", direction: "right", ratio: "0.5", noFocus: true },
      { paneId: "w-role:p1", direction: "right", ratio: "0.5", noFocus: true },
    ]);
    await assert.rejects(readFile(path.join(failedDir, "inspectors", "herdr.json"), "utf8"), { code: "ENOENT" });
  } finally {
    dispose();
  }
});

test("valid legacy bindings recover a live split target", async () => {
  const existingDir = await mkdtemp(path.join(tmpdir(), "herdr-topology-existing-"));
  const bindingFile = path.join(existingDir, "inspectors", "herdr.json");
  await mkdir(path.dirname(bindingFile), { recursive: true });
  await writeFile(bindingFile, `${JSON.stringify({
    schemaVersion: 1,
    kind: "herdr-inspector",
    runId: "run-existing",
    asyncDir: existingDir,
    paneId: "w-role:p2",
    openedAt: "2026-08-17T00:00:00.000Z",
    command: "inspector",
  })}\n`);
  const fixture = createTopologyFixture();
  fixture.livePanes.add("w-role:p2");
  const dispose = installTopologyFixture(fixture, "binding", 3);
  try {
    emitAsyncStart(fixture, { id: "run-existing", asyncDir: existingDir, cwd: "/repo" });
    await waitFor(() => fixture.calls.some((args) => args[0] === "pane" && args[1] === "get" && args[2] === "w-role:p2"));
    await openSingleInspector(fixture, "run-next");
    assert.deepEqual(splitDetails(fixture.calls).at(-1), {
      paneId: "w-role:p2",
      direction: "down",
      ratio: "0.5",
      noFocus: true,
    });
  } finally {
    dispose();
  }
});

test("malformed bindings and zero capacity do not create inspector panes", async (t) => {
  await t.test("malformed binding", async () => {
    const malformedDir = await mkdtemp(path.join(tmpdir(), "herdr-topology-malformed-"));
    await mkdir(path.join(malformedDir, "inspectors"), { recursive: true });
    await writeFile(path.join(malformedDir, "inspectors", "herdr.json"), "{ invalid json");
    const fixture = createTopologyFixture();
    const dispose = installTopologyFixture(fixture, "malformed", 3);
    try {
      emitAsyncStart(fixture, { id: "run-malformed", asyncDir: malformedDir, cwd: "/repo" });
      await openSingleInspector(fixture, "run-next");
      assert.deepEqual(splitDetails(fixture.calls), [
        { paneId: "w-role:p1", direction: "right", ratio: "0.5", noFocus: true },
      ]);
    } finally {
      dispose();
    }
  });

  await t.test("zero capacity", async () => {
    const fixture = createTopologyFixture();
    const dispose = installTopologyFixture(fixture, "zero", 0);
    try {
      emitAsyncStart(fixture, {
        id: "run-zero",
        asyncDir: await mkdtemp(path.join(tmpdir(), "herdr-topology-zero-")),
        cwd: "/repo",
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(fixture.calls, []);
    } finally {
      dispose();
    }
  });
});
