import path from "node:path";
import { runChecked, runProcess } from "./process.mjs";

async function git(cwd, args, options = {}) {
  return runChecked("git", ["-C", cwd, ...args], options);
}

export async function repositoryRoot(candidate, options = {}) {
  const result = await git(candidate, ["rev-parse", "--show-toplevel"], options);
  return path.resolve(result.stdout.trim());
}

export async function gitSnapshot(candidate, options = {}) {
  const root = await repositoryRoot(candidate, options);
  const [branchResult, headResult, statusResult] = await Promise.all([
    runProcess("git", ["-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"], options),
    git(root, ["rev-parse", "--verify", "HEAD"], options),
    git(root, ["status", "--porcelain=v1", "--untracked-files=all"], options),
  ]);
  const branch = branchResult.code === 0 ? branchResult.stdout.trim() : null;
  const status = statusResult.stdout.replace(/\s+$/u, "");
  return {
    root,
    branch,
    head: headResult.stdout.trim(),
    clean: status.length === 0,
    status,
  };
}

export async function assertCleanSnapshot(candidate, options = {}) {
  const snapshot = await gitSnapshot(candidate, options);
  if (!snapshot.clean) {
    throw new Error(`Repository is not clean:\n${snapshot.status}`);
  }
  if (!snapshot.branch) throw new Error("Detached HEAD is not supported for a new workflow.");
  return snapshot;
}

export async function assertSnapshotUnchanged(expected, options = {}) {
  const current = await assertCleanSnapshot(expected.root, options);
  if (current.branch !== expected.branch) {
    throw new Error(`Approved branch changed from '${expected.branch}' to '${current.branch}'.`);
  }
  if (current.head !== expected.head) {
    throw new Error(`Approved HEAD changed from '${expected.head}' to '${current.head}'.`);
  }
  return current;
}

export async function validateBranch(root, branch, options = {}) {
  const format = await runProcess("git", ["check-ref-format", "--branch", branch], options);
  if (format.code !== 0) throw new Error(`Invalid task branch: ${branch}`);
  const exists = await runProcess("git", ["-C", root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], options);
  if (exists.code === 0) throw new Error(`Task branch already exists: ${branch}`);
}

export async function createLinkedWorktree({ root, branch, base, worktreePath }, options = {}) {
  const result = await runChecked("git", ["-C", root, "worktree", "add", "-b", branch, worktreePath, base], options);
  return { path: path.resolve(worktreePath), branch, base, output: result.stdout.trim() };
}

export async function createDetachedWorktree({ root, base, worktreePath }, options = {}) {
  const result = await runChecked("git", ["-C", root, "worktree", "add", "--detach", worktreePath, base], options);
  return { path: path.resolve(worktreePath), branch: null, detached: true, base, output: result.stdout.trim() };
}
