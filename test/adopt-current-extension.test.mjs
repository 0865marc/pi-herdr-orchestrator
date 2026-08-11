import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createJiti } from "jiti";

const exec = promisify(execFile);
const jiti = createJiti(import.meta.url);
const { default: piHerdrOrchestrator } = await jiti.import("../extensions/pi-herdr-orchestrator.ts");

async function fixtureRepository() {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-adopt-extension-repo-"));
  await exec("git", ["init", "-b", "main"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await exec("git", ["config", "user.name", "Workflow Test"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "fixture\n");
  await exec("git", ["add", "README.md"], { cwd: root });
  await exec("git", ["commit", "-m", "fixture"], { cwd: root });
  return root;
}

test("adopt-current promotes and restores the same Pi session without creating a workspace", async () => {
  const repository = await fixtureRepository();
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "herdr-adopt-extension-"));
  const stateHome = path.join(fixtureRoot, "state");
  const herdrLog = path.join(fixtureRoot, "herdr.jsonl");
  const fakeHerdr = path.join(fixtureRoot, "herdr");
  await writeFile(fakeHerdr, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify(args) + "\\n");
let response = { result: { type: "ok" } };
if (args[0] === "agent" && args[1] === "get") {
  response = { result: { agent: { agent: "pi", name: "project-pi", pane_id: "w-current:p1", workspace_id: "w-current" } } };
} else if (args[0] === "workspace" && args[1] === "get") {
  response = { result: { workspace: { workspace_id: "w-current", label: "project" } } };
}
writeFileSync(1, JSON.stringify(response));
`);
  await chmod(fakeHerdr, 0o755);

  const previousEnv = { ...process.env };
  Object.assign(process.env, {
    PATH: `${fixtureRoot}${path.delimiter}${process.env.PATH}`,
    XDG_STATE_HOME: stateHome,
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: "/tmp/fixture.sock",
    HERDR_WORKSPACE_ID: "w-current",
    HERDR_PANE_ID: "w-current:p1",
    FAKE_HERDR_LOG: herdrLog,
  });
  delete process.env.PI_HERDR_ORCHESTRATOR_ROLE;
  delete process.env.PI_HERDR_ORCHESTRATOR_RUN_ID;

  const originalModel = { provider: "fixture", id: "normal" };
  const targetModel = { provider: "openai-codex", id: "gpt-5.6-sol" };
  let model = originalModel;
  let thinking = "medium";
  let tools = ["read", "bash", "edit", "write", "pi_herdr_orchestrator", "subagent", "subagent_wait", "grep", "find", "ls"];
  let sessionName = "project session";
  let failTargetModel = false;
  const userMessages = [];
  const handlers = new Map();
  const eventHandlers = new Map();
  let workflowTool;
  const pi = {
    registerTool(tool) { workflowTool = tool; },
    on(name, handler) {
      const entries = handlers.get(name) ?? [];
      entries.push(handler);
      handlers.set(name, entries);
    },
    events: {
      on(name, handler) {
        eventHandlers.set(name, handler);
        return () => eventHandlers.delete(name);
      },
    },
    getAllTools() { return tools.map((name) => ({ name })); },
    getActiveTools() { return [...tools]; },
    setActiveTools(next) { tools = [...next]; },
    getThinkingLevel() { return thinking; },
    setThinkingLevel(next) { thinking = next; },
    getSessionName() { return sessionName; },
    setSessionName(next) { sessionName = next; },
    async setModel(next) {
      if (failTargetModel && next === targetModel) return false;
      model = next;
      return true;
    },
    sendUserMessage(message) { userMessages.push(message); },
    async exec() { return { code: 0, stdout: JSON.stringify({ result: { type: "ok" } }), stderr: "" }; },
  };
  const ctx = {
    cwd: repository,
    model: originalModel,
    modelRegistry: { find(provider, id) { return provider === targetModel.provider && id === targetModel.id ? targetModel : undefined; } },
    sessionManager: { getSessionId() { return "session-current"; } },
  };

  try {
    piHerdrOrchestrator(pi);
    const started = await workflowTool.execute("call-start", {
      action: "start",
      repository,
      task: "Implement the adopted workflow",
      launchMode: "adopt-current",
      approved: true,
    }, new AbortController().signal, undefined, ctx);
    assert.equal(started.details.adoptionPending, true);
    assert.equal(userMessages.length, 0);

    await handlers.get("agent_settled")[0]({}, ctx);
    assert.equal(model, targetModel);
    assert.equal(thinking, "max");
    assert.deepEqual(tools, ["read", "grep", "find", "ls", "pi_herdr_orchestrator", "subagent", "subagent_wait"]);
    assert.equal(sessionName, `${path.basename(repository)} · orchestrator`);
    assert.equal(process.env.PI_HERDR_ORCHESTRATOR_ROLE, "orchestrator");
    assert.equal(process.env.PI_HERDR_ORCHESTRATOR_RUN_ID, started.details.runId);
    assert.equal(userMessages.length, 1);
    assert.match(userMessages[0], /already bootstrapped/u);

    const promptResult = await handlers.get("before_agent_start")[0]({ systemPrompt: "base prompt" }, ctx);
    assert.match(promptResult.systemPrompt, /base prompt/u);
    assert.match(promptResult.systemPrompt, /Pi Orchestrator/u);
    const guardResult = await handlers.get("tool_call")[0]({ toolName: "write", input: { path: "file" } }, ctx);
    assert.equal(guardResult.block, true);

    const finishing = await workflowTool.execute("call-finish", {
      action: "finish",
      runId: started.details.runId,
    }, new AbortController().signal, undefined, ctx);
    assert.equal(finishing.details.finishPending, true);
    await handlers.get("agent_settled")[0]({}, ctx);

    assert.equal(model, originalModel);
    assert.equal(thinking, "medium");
    assert.equal(sessionName, "project session");
    assert.equal(process.env.PI_HERDR_ORCHESTRATOR_ROLE, undefined);
    assert.equal(process.env.PI_HERDR_ORCHESTRATOR_RUN_ID, undefined);
    const calls = (await readFile(herdrLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls.some((args) => args[0] === "workspace" && args[1] === "create"), false);
    assert.equal(calls.some((args) => args[0] === "agent" && args[1] === "start"), false);
    assert.deepEqual(calls.filter((args) => args[0] === "workspace" && args[1] === "rename").map((args) => args[3]), [`${path.basename(repository)} · orchestrator`, "project"]);

    failTargetModel = true;
    const failed = await workflowTool.execute("call-failed-start", {
      action: "start",
      repository,
      task: "Exercise adoption rollback",
      launchMode: "adopt-current",
      approved: true,
    }, new AbortController().signal, undefined, { ...ctx, model: originalModel });
    await handlers.get("agent_settled")[0]({}, ctx);
    assert.equal(failed.details.adoptionPending, true);
    assert.equal(model, originalModel);
    assert.equal(thinking, "medium");
    assert.equal(sessionName, "project session");
    assert.equal(process.env.PI_HERDR_ORCHESTRATOR_ROLE, undefined);
    assert.match(userMessages.at(-1), /adoption failed/u);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  }
});
