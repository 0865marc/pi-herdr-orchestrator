import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openWorktreeWorkspace } from "../src/herdr.mjs";

test("worktree role workspace preserves hierarchy and replaces the blank shell", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-workflow-cli-"));
  const fixture = path.join(root, "fake-herdr.mjs");
  const log = path.join(root, "calls.jsonl");
  await writeFile(fixture, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify(args) + "\\n");
const response = args[0] === "worktree"
  ? { result: { already_open: false, workspace: { workspace_id: "w-child" }, root_pane: { pane_id: "w-child:p1" } } }
  : args[0] === "pane" && args[1] === "split"
    ? { result: { pane: { pane_id: "w-child:p2" } } }
    : { result: { type: "ok" } };
writeFileSync(1, JSON.stringify(response));
`);
  await chmod(fixture, 0o755);
  const opened = await openWorktreeWorkspace({
    sourceWorkspaceId: "w-parent",
    cwd: "/repo/worktree",
    label: "project · scout",
    env: { HERDR_WORKFLOW_ROLE: "scout" },
    focus: false,
  }, { bin: fixture, env: { ...process.env, FAKE_HERDR_LOG: log } });
  assert.equal(opened.workspaceId, "w-child");
  assert.equal(opened.paneId, "w-child:p2");
  const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [["worktree", "open"], ["pane", "split"], ["pane", "close"]]);
  assert.ok(calls[0].includes("w-parent"));
  assert.ok(calls[1].includes("HERDR_WORKFLOW_ROLE=scout"));
  assert.equal(calls[2][2], "w-child:p1");
});
