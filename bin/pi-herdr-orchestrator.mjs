#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import {
  closeRole,
  doctor,
  preflight,
  promptRole,
  readRole,
  startRole,
  startWorkflow,
  statusWorkflow,
  waitRole,
} from "../src/controller.mjs";

const [command = "help", ...argv] = process.argv.slice(2);
const parsed = parseArgs({
  args: argv,
  allowPositionals: true,
  options: {
    repo: { type: "string" },
    task: { type: "string" },
    run: { type: "string" },
    role: { type: "string" },
    prompt: { type: "string" },
    branch: { type: "string" },
    timeout: { type: "string" },
    lines: { type: "string" },
    approved: { type: "boolean", default: false },
    focus: { type: "boolean", default: false },
    wait: { type: "boolean", default: false },
  },
});

const values = parsed.values;
const timeoutMs = values.timeout ? Number(values.timeout) : undefined;
const lines = values.lines ? Number(values.lines) : undefined;

function usage() {
  const executable = path.basename(process.argv[1] ?? "pi-herdr-orchestrator");
  return `Usage:
  ${executable} doctor [--repo PATH]
  ${executable} preflight [--repo PATH]
  ${executable} start --repo PATH --task TEXT --approved [--focus]
  ${executable} start-role --run ID --role scout|builder|reviewer --prompt TEXT --approved [--branch NAME]
  ${executable} prompt-role --run ID --role ROLE --prompt TEXT [--wait] [--timeout MS]
  ${executable} wait-role --run ID --role ROLE [--timeout MS]
  ${executable} read-role --run ID --role ROLE [--lines N]
  ${executable} status --run ID
  ${executable} close-role --run ID --role ROLE --approved

The skill is the primary entry point. This CLI is a deterministic diagnostic fallback.
No command commits, pushes, merges, rebases, deletes branches, or removes worktrees.`;
}

async function main() {
  switch (command) {
    case "doctor": return doctor({ cwd: values.repo });
    case "preflight": return preflight({ repository: values.repo });
    case "start": return startWorkflow({ repository: values.repo, task: values.task, approved: values.approved, focus: values.focus });
    case "start-role": return startRole({ runId: values.run, role: values.role, prompt: values.prompt, taskBranch: values.branch, approved: values.approved, focus: values.focus });
    case "prompt-role": return promptRole({ runId: values.run, role: values.role, prompt: values.prompt, wait: values.wait, timeoutMs });
    case "wait-role": return waitRole({ runId: values.run, role: values.role, timeoutMs });
    case "read-role": return readRole({ runId: values.run, role: values.role, lines });
    case "status": return statusWorkflow({ runId: values.run });
    case "close-role": return closeRole({ runId: values.run, role: values.role, approved: values.approved });
    case "help":
    case "--help":
    case "-h": return { usage: usage() };
    default: throw new Error(`Unknown command '${command}'.\n${usage()}`);
  }
}

try {
  const result = await main();
  if (result?.usage) process.stdout.write(`${result.usage}\n`);
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  process.exitCode = 1;
}
