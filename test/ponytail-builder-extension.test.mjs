import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { default: registerBuilderPonytail } = await jiti.import("../extensions/ponytail-builder.ts");

test("Builder receives fixed Ponytail full guidance without global commands", async () => {
  const handlers = new Map();
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand() { throw new Error("Builder adapter must not expose Ponytail configuration commands."); },
  };

  registerBuilderPonytail(pi);

  assert.deepEqual([...handlers.keys()], ["before_agent_start"]);
  const result = await handlers.get("before_agent_start")({ systemPrompt: "Builder base prompt" });
  assert.match(result.systemPrompt, /^Builder base prompt/u);
  assert.match(result.systemPrompt, /PONYTAIL MODE ACTIVE — level: full/u);
  assert.match(result.systemPrompt, /Never simplify away/u);
  assert.match(result.systemPrompt, /fixed to full for this Builder session/u);
  assert.match(result.systemPrompt, /approved plan.*remain authoritative/u);
});
