import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import autoInspectors from "../extensions/auto-inspectors.ts";

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for asynchronous inspector work.");
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
    autoInspectors(pi);
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
