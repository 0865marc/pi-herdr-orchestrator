import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import autoInspectors from "../extensions/auto-inspectors.ts";

test("async subagent starts automatically open a non-focused Herdr inspector", async () => {
  const asyncDir = await mkdtemp(path.join(tmpdir(), "herdr-auto-inspector-"));
  const eventHandlers = new Map();
  const lifecycleHandlers = new Map();
  const calls = [];
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
        ? { result: { pane: { pane_id: "w-role:p2" } } }
        : { result: { type: "ok" } };
      return { code: 0, stdout: JSON.stringify(payload), stderr: "" };
    },
  };
  const previous = {
    role: process.env.HERDR_WORKFLOW_ROLE,
    pane: process.env.HERDR_PANE_ID,
    max: process.env.HERDR_WORKFLOW_MAX_INSPECTOR_PANES,
  };
  process.env.HERDR_WORKFLOW_ROLE = "scout";
  process.env.HERDR_PANE_ID = "w-role:p1";
  process.env.HERDR_WORKFLOW_MAX_INSPECTOR_PANES = "3";
  try {
    autoInspectors(pi);
    eventHandlers.get("subagent:async-started")({ id: "run-12345678", asyncDir, cwd: "/repo" });
    for (let attempt = 0; attempt < 50 && calls.length < 3; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(calls.map((args) => args.slice(0, 2)), [["pane", "split"], ["pane", "run"], ["pane", "rename"]]);
    assert.ok(calls[0].includes("--no-focus"));
    const binding = JSON.parse(await readFile(path.join(asyncDir, "inspectors", "herdr.json"), "utf8"));
    assert.equal(binding.runId, "run-12345678");
    assert.equal(binding.paneId, "w-role:p2");
    lifecycleHandlers.get("session_shutdown")();
    assert.equal(eventHandlers.has("subagent:async-started"), false);
  } finally {
    if (previous.role === undefined) delete process.env.HERDR_WORKFLOW_ROLE; else process.env.HERDR_WORKFLOW_ROLE = previous.role;
    if (previous.pane === undefined) delete process.env.HERDR_PANE_ID; else process.env.HERDR_PANE_ID = previous.pane;
    if (previous.max === undefined) delete process.env.HERDR_WORKFLOW_MAX_INSPECTOR_PANES; else process.env.HERDR_WORKFLOW_MAX_INSPECTOR_PANES = previous.max;
  }
});
