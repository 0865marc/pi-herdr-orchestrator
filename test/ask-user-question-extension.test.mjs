import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { default: registerAskUserQuestion } = await jiti.import("../extensions/ask-user-question.ts");

test("the packaged questionnaire extension registers and safely gates its interactive tool", async () => {
  const tools = [];
  const handlers = new Map();
  const pi = {
    registerTool(tool) { tools.push(tool); },
    on(name, handler) { handlers.set(name, handler); },
    events: { emit() {} },
    getActiveTools() { return tools.map((tool) => tool.name); },
    setActiveTools() {},
  };

  registerAskUserQuestion(pi);

  assert.deepEqual(tools.map((tool) => tool.name), ["ask_user_question"]);
  assert.equal(typeof handlers.get("before_agent_start"), "function");
  const result = await tools[0].execute("call-1", {
    questions: [{
      question: "Which implementation should the plan use?",
      header: "Approach",
      options: [
        { label: "Option A (Recommended)", description: "Use the established project pattern." },
        { label: "Option B", description: "Introduce a separate implementation." },
      ],
    }],
  }, new AbortController().signal, undefined, { hasUI: false });
  assert.equal(result.details.cancelled, true);
  assert.equal(result.details.error, "no_ui");
});
