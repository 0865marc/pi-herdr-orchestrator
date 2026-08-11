import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PACKAGE_ROOT } from "../src/config.mjs";

async function rolePrompt(role) {
  return readFile(path.join(PACKAGE_ROOT, "roles", `${role}.md`), "utf8");
}

test("Builder and Reviewer adapt Orchestrator candidates before optional async fan-out", async () => {
  for (const role of ["builder", "reviewer"]) {
    const prompt = await rolePrompt(role);
    assert.match(prompt, /Parallel (?:support|review) candidates/u);
    assert.match(prompt, /runs\.all/u);
    assert.match(prompt, /runs\.run/u);
    assert.match(prompt, /async:true/u);
    assert.match(prompt, /context:"fresh"/u);
    assert.match(prompt, /artifacts:false/u);
    assert.match(prompt, /mission:false/u);
    assert.match(prompt, /subagent_wait/u);
    assert.match(prompt, /label/u);
    assert.match(prompt, /one sibling Herdr pane per fan-out child/u);
    assert.doesNotMatch(prompt, /must immediately launch|two or three distinct/u);
  }
});

test("Orchestrator proposes task-specific lanes without making delegation mandatory", async () => {
  const prompt = await rolePrompt("orchestrator");
  assert.match(prompt, /Parallel support candidates/u);
  assert.match(prompt, /Parallel review candidates/u);
  assert.match(prompt, /stable ID, short display label, exact scope, one question, expected evidence/u);
  assert.match(prompt, /absence of delegation is not itself a failure/u);
  assert.doesNotMatch(prompt, /generic number of children.*require parallel/su);
});
