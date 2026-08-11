import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  abortWriterWave,
  integrateWriterWave,
  launchWriterWave,
  readWriterLane,
  resolveWriterWave,
  statusWriterWave,
  waitWriterWave,
} from "../src/writer-wave.mjs";

const Lane = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  label: Type.String({ minLength: 1, maxLength: 48 }),
  scope: Type.String({ minLength: 1 }),
  write_set: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  task: Type.String({ minLength: 1 }),
  acceptance: Type.String({ minLength: 1 }),
  depends_on: Type.Optional(Type.Array(Type.String())),
});

const Parameters = Type.Object({
  action: Type.Union([
    Type.Literal("launch"),
    Type.Literal("status"),
    Type.Literal("wait"),
    Type.Literal("read"),
    Type.Literal("integrate"),
    Type.Literal("abort"),
    Type.Literal("resolve"),
  ]),
  runId: Type.Optional(Type.String()),
  lanes: Type.Optional(Type.Array(Lane, { minItems: 1, maxItems: 3 })),
  laneId: Type.Optional(Type.String()),
  lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_800_000 })),
  resolution: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
});

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

export default function builderWriters(pi: ExtensionAPI) {
  if (process.env.PI_HERDR_ORCHESTRATOR_ROLE !== "builder") return;
  pi.registerTool({
    name: "pi_herdr_writers",
    label: "Pi Herdr Writers",
    description: "Launch and transactionally integrate a bounded pre-mutation wave of controller-owned Writer panes. Every lane requires a disjoint write_set; writers have no Bash or delegation.",
    parameters: Parameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let result;
      switch (params.action) {
        case "launch":
          if (!params.lanes) throw new Error("launch requires lanes.");
          result = await launchWriterWave({ runId: params.runId, lanes: params.lanes, cwd: ctx.cwd, signal });
          break;
        case "status":
          result = await statusWriterWave({ runId: params.runId, cwd: ctx.cwd, signal });
          break;
        case "wait":
          result = await waitWriterWave({ runId: params.runId, cwd: ctx.cwd, timeoutMs: params.timeoutMs, signal });
          break;
        case "read":
          if (!params.laneId) throw new Error("read requires laneId.");
          result = await readWriterLane({ runId: params.runId, laneId: params.laneId, lines: params.lines, cwd: ctx.cwd, signal });
          break;
        case "integrate":
          result = await integrateWriterWave({ runId: params.runId, cwd: ctx.cwd, signal });
          break;
        case "abort":
          result = await abortWriterWave({ runId: params.runId, reason: params.reason, cwd: ctx.cwd, signal });
          break;
        case "resolve":
          result = await resolveWriterWave({ runId: params.runId, resolution: params.resolution, cwd: ctx.cwd, signal });
          break;
      }
      return jsonResult(result);
    },
  });
}
