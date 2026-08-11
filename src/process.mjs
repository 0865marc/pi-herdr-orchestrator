import { spawn } from "node:child_process";

const DEFAULT_OUTPUT_LIMIT = 4 * 1024 * 1024;

export class ProcessError extends Error {
  constructor(command, args, result) {
    const rendered = [command, ...args].join(" ");
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    super(`${rendered} failed: ${detail}`);
    this.name = "ProcessError";
    this.command = command;
    this.args = [...args];
    this.result = result;
  }
}

export function runProcess(command, args = [], options = {}) {
  const {
    cwd,
    env,
    input,
    signal,
    timeoutMs = 30_000,
    outputLimit = DEFAULT_OUTPUT_LIMIT,
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
      windowsHide: true,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      return next.length > outputLimit ? next.slice(-outputLimit) : next;
    };

    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });

    const stop = () => {
      if (!settled) child.kill("SIGTERM");
    };
    const timer = timeoutMs > 0 ? setTimeout(stop, timeoutMs) : undefined;
    timer?.unref?.();
    signal?.addEventListener("abort", stop, { once: true });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      reject(error);
    });

    child.on("close", (code, childSignal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve({ code: code ?? 1, signal: childSignal, stdout, stderr });
    });

    if (input !== undefined) child.stdin.end(input);
  });
}

export async function runChecked(command, args = [], options = {}) {
  const result = await runProcess(command, args, options);
  if (result.code !== 0) throw new ProcessError(command, args, result);
  return result;
}

export async function commandExists(command, options = {}) {
  try {
    const result = await runProcess(command, ["--version"], { ...options, timeoutMs: 5_000 });
    return result.code === 0;
  } catch {
    return false;
  }
}
