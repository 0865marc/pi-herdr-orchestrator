import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runChecked } from "../src/process.mjs";
import { assertCleanSnapshot, gitSnapshot } from "../src/git.mjs";

test("Git preflight distinguishes clean and dirty repositories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-workflow-git-"));
  await runChecked("git", ["init", "-b", "main", root]);
  await runChecked("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  await runChecked("git", ["-C", root, "config", "user.name", "Workflow Test"]);
  await writeFile(path.join(root, "README.md"), "fixture\n");
  await runChecked("git", ["-C", root, "add", "README.md"]);
  await runChecked("git", ["-C", root, "commit", "-m", "fixture"]);
  const clean = await assertCleanSnapshot(root);
  assert.equal(clean.clean, true);
  assert.equal(clean.branch, "main");
  await writeFile(path.join(root, "README.md"), "dirty\n");
  const dirty = await gitSnapshot(root);
  assert.equal(dirty.clean, false);
  assert.match(dirty.status, /README\.md/u);
});
