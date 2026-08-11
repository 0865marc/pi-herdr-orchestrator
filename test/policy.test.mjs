import test from "node:test";
import assert from "node:assert/strict";
import { decideToolCall } from "../src/policy.mjs";

const policy = {
  reviewerAllowedCommands: ["git diff", "npm test"],
  builderDeniedPatterns: ["(^|\\s)git\\s+(commit|push)(\\s|$)", "rm\\s+-rf"],
};

test("extension stays inert outside workflow roles", () => {
  assert.equal(decideToolCall({ toolName: "bash", input: { command: "rm -rf /" }, root: "/repo", policy }), null);
});

test("role roots prevent path escape", () => {
  assert.match(decideToolCall({ role: "scout", toolName: "read", input: { path: "../secret" }, root: "/repo", cwd: "/repo", policy }), /outside/u);
  assert.equal(decideToolCall({ role: "scout", toolName: "read", input: { path: "src/app.ts" }, root: "/repo", cwd: "/repo", policy }), null);
});

test("read-only package references are allowed without widening write roots", () => {
  assert.equal(decideToolCall({ role: "scout", toolName: "read", input: { path: "/package/skills/pi/SKILL.md" }, root: "/repo", readRoots: ["/package"], policy }), null);
  assert.match(decideToolCall({ role: "builder", toolName: "write", input: { path: "/package/file" }, root: "/repo", readRoots: ["/package"], policy }), /outside/u);
});

test("workflow roles cannot recurse or hide foreground subagents", () => {
  assert.match(decideToolCall({ role: "orchestrator", toolName: "pi_herdr_orchestrator", input: { action: "start" }, root: "/repo", policy }), /already running/u);
  assert.equal(decideToolCall({ role: "orchestrator", toolName: "ask_user_question", input: { questions: [] }, root: "/repo", policy }), null);
  assert.match(decideToolCall({ role: "scout", toolName: "subagent", input: { agent: "pi-herdr-orchestrator.scout" }, root: "/repo", policy }), /workflowScript/u);
  assert.match(decideToolCall({ role: "scout", toolName: "subagent", input: { workflowScript: "return runs.run('x', input)", async: false }, root: "/repo", policy }), /asynchronously/u);
  assert.match(decideToolCall({ role: "scout", toolName: "subagent", input: { workflowScript: "return runs.run('x', input)" }, root: "/repo", policy }), /artifacts:false/u);
  assert.match(decideToolCall({ role: "scout", toolName: "subagent", input: { workflowScript: "return runs.run('x', input)", artifacts: false }, root: "/repo", policy }), /mission:false/u);
  assert.equal(decideToolCall({ role: "scout", toolName: "subagent", input: { workflowScript: "return runs.run('x', { agent: 'pi-herdr-orchestrator.scout', task: 'inspect' })", artifacts: false, mission: false }, root: "/repo", policy }), null);
  assert.equal(decideToolCall({ role: "scout", toolName: "subagent", input: { action: "inspector.status", id: "run" }, root: "/repo", policy }), null);
});

test("reviewer is read-only with a strict shell allowlist", () => {
  assert.match(decideToolCall({ role: "reviewer", toolName: "write", input: { path: "x" }, root: "/repo", policy }), /read-only/u);
  assert.equal(decideToolCall({ role: "reviewer", toolName: "bash", input: { command: "npm test -- --runInBand" }, root: "/repo", policy }), null);
  assert.match(decideToolCall({ role: "reviewer", toolName: "bash", input: { command: "npm test && rm file" }, root: "/repo", policy }), /allowlist/u);
});

test("builder blocks publication and nested writers", () => {
  assert.match(decideToolCall({ role: "builder", toolName: "bash", input: { command: "git push origin HEAD" }, root: "/repo", policy }), /denied/u);
  assert.match(decideToolCall({ role: "builder", isChild: true, toolName: "edit", input: { path: "src/x.ts" }, root: "/repo", policy }), /single writer/u);
  assert.equal(decideToolCall({ role: "builder", toolName: "edit", input: { path: "src/x.ts" }, root: "/repo", policy }), null);
});
