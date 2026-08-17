import test from "node:test";
import assert from "node:assert/strict";
import roleAppearance, {
  ROLE_APPEARANCE_KEY,
  ROLE_APPEARANCES,
  roleAppearanceFor,
} from "../extensions/role-appearance.ts";

async function withWorkflowRole(role, execute) {
  const previous = process.env.PI_HERDR_ORCHESTRATOR_ROLE;
  if (role === undefined) delete process.env.PI_HERDR_ORCHESTRATOR_ROLE;
  else process.env.PI_HERDR_ORCHESTRATOR_ROLE = role;
  try {
    return await execute();
  } finally {
    if (previous === undefined) delete process.env.PI_HERDR_ORCHESTRATOR_ROLE;
    else process.env.PI_HERDR_ORCHESTRATOR_ROLE = previous;
  }
}

function createAppearanceFixture() {
  const handlers = new Map();
  const calls = [];
  const ui = {
    theme: {
      fg(color, text) {
        return `${color}:${text}`;
      },
    },
    setWidget(key, content, options) {
      calls.push({ method: "widget", key, content, options });
    },
    setStatus(key, text) {
      calls.push({ method: "status", key, text });
    },
  };
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
  };
  return { pi, handlers, calls, ui };
}

test("role appearance data provides distinct readable markers and semantic colors", () => {
  const appearances = Object.values(ROLE_APPEARANCES);
  assert.equal(appearances.length, 4);
  assert.equal(new Set(appearances.map((appearance) => appearance.icon)).size, 4);
  assert.equal(new Set(appearances.map((appearance) => appearance.label)).size, 4);
  assert.equal(new Set(appearances.map((appearance) => appearance.color)).size, 4);
  assert.deepEqual(roleAppearanceFor("orchestrator"), ROLE_APPEARANCES.orchestrator);
  assert.deepEqual(roleAppearanceFor("scout"), ROLE_APPEARANCES.scout);
  assert.deepEqual(roleAppearanceFor("builder"), ROLE_APPEARANCES.builder);
  assert.deepEqual(roleAppearanceFor("reviewer"), ROLE_APPEARANCES.reviewer);
  assert.equal(roleAppearanceFor("unknown"), undefined);
  assert.equal(roleAppearanceFor(undefined), undefined);
});

test("role appearance installs an above-editor badge and clears it on shutdown", async () => {
  await withWorkflowRole("builder", async () => {
    const fixture = createAppearanceFixture();
    roleAppearance(fixture.pi);
    const ctx = { hasUI: true, ui: fixture.ui };
    const start = fixture.handlers.get("session_start");
    const shutdown = fixture.handlers.get("session_shutdown");
    assert.equal(typeof start, "function");
    assert.equal(typeof shutdown, "function");
    if (typeof start === "function") start({}, ctx);
    assert.deepEqual(fixture.calls, [
      {
        method: "widget",
        key: ROLE_APPEARANCE_KEY,
        content: ["warning:[B] BUILDER"],
        options: { placement: "aboveEditor" },
      },
      { method: "status", key: ROLE_APPEARANCE_KEY, text: "warning:[B] BUILDER" },
    ]);
    if (typeof shutdown === "function") shutdown();
    assert.deepEqual(fixture.calls.slice(2), [
      {
        method: "widget",
        key: ROLE_APPEARANCE_KEY,
        content: undefined,
        options: { placement: "aboveEditor" },
      },
      { method: "status", key: ROLE_APPEARANCE_KEY, text: undefined },
    ]);
  });
});

test("missing or unknown workflow roles leave the host UI untouched", async () => {
  for (const role of [undefined, "unknown"]) {
    await withWorkflowRole(role, async () => {
      const fixture = createAppearanceFixture();
      roleAppearance(fixture.pi);
      const start = fixture.handlers.get("session_start");
      assert.equal(typeof start, "function");
      if (typeof start === "function") start({}, { hasUI: true, ui: fixture.ui });
      assert.deepEqual(fixture.calls, []);
    });
  }
});
