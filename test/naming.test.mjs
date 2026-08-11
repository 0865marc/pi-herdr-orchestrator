import test from "node:test";
import assert from "node:assert/strict";
import { agentName, defaultTaskBranch, shortHash, slugify, workspaceLabel } from "../src/naming.mjs";

test("portable names are stable and Herdr-compatible", () => {
  assert.equal(slugify("Árbol de Decisiones"), "arbol-de-decisiones");
  assert.equal(workspaceLabel("ainki", "builder"), "ainki · builder");
  const name = agentName("A project with a very long descriptive name", "orchestrator", "run-123");
  assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/u);
  assert.ok(name.length <= 32);
  assert.equal(name, agentName("A project with a very long descriptive name", "orchestrator", "run-123"));
});

test("task branches are namespaced and bounded", () => {
  const branch = defaultTaskBranch("Implement role workspaces and inspector panes", "run-123");
  assert.match(branch, /^workflow\/[a-z0-9-]+-[a-f0-9]{6}$/u);
  assert.ok(branch.length < 64);
  assert.equal(shortHash("x", 4).length, 4);
});
