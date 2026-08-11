import path from "node:path";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, readlink, rm, symlink } from "node:fs/promises";
import { runChecked } from "./process.mjs";

function nulList(value) {
  return value.split("\0").filter(Boolean);
}

function safeRelativePath(value) {
  if (typeof value !== "string" || !value || path.isAbsolute(value)) {
    throw new Error(`Unsafe review snapshot path: ${String(value)}`);
  }
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Unsafe review snapshot path: ${value}`);
  }
  return normalized;
}

async function optionalLstat(file) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function ensureParents(root, relative) {
  const segments = relative.split(path.sep).slice(0, -1);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await optionalLstat(current);
    if (stat?.isDirectory() && !stat.isSymbolicLink()) continue;
    if (stat) await rm(current, { recursive: true, force: true });
    await mkdir(current, { mode: 0o755 });
  }
}

async function copyEntry(sourceRoot, destinationRoot, relative) {
  const source = path.join(sourceRoot, relative);
  const destination = path.join(destinationRoot, relative);
  const stat = await optionalLstat(source);
  await rm(destination, { recursive: true, force: true });
  if (!stat) return { path: relative, kind: "missing" };
  await ensureParents(destinationRoot, relative);
  if (stat.isSymbolicLink()) {
    const target = await readlink(source);
    await symlink(target, destination);
    return { path: relative, kind: "symlink", target };
  }
  if (!stat.isFile()) {
    throw new Error(`Reviewer snapshot cannot safely mirror non-file path '${relative}'.`);
  }
  await copyFile(source, destination);
  await chmod(destination, stat.mode & 0o777);
  const digest = createHash("sha256").update(await readFile(source)).digest("hex");
  return { path: relative, kind: "file", mode: stat.mode & 0o777, digest };
}

async function entryFingerprint(root, entry) {
  const relative = safeRelativePath(entry.path);
  const stat = await optionalLstat(path.join(root, relative));
  if (!stat) return { path: relative, kind: "missing" };
  if (stat.isSymbolicLink()) return { path: relative, kind: "symlink", target: await readlink(path.join(root, relative)) };
  if (!stat.isFile()) return { path: relative, kind: "unsupported" };
  return {
    path: relative,
    kind: "file",
    mode: stat.mode & 0o777,
    digest: createHash("sha256").update(await readFile(path.join(root, relative))).digest("hex"),
  };
}

async function git(cwd, args, options) {
  return runChecked("git", ["-C", cwd, ...args], options);
}

export async function syncReviewSnapshot({ builderRoot, reviewerRoot, previousEntries = [] }, options = {}) {
  const [builderHead, reviewerHead] = await Promise.all([
    git(builderRoot, ["rev-parse", "--verify", "HEAD"], options),
    git(reviewerRoot, ["rev-parse", "--verify", "HEAD"], options),
  ]);
  if (builderHead.stdout.trim() !== reviewerHead.stdout.trim()) {
    throw new Error("Reviewer snapshot HEAD no longer matches Builder HEAD.");
  }

  for (const entry of previousEntries) {
    if (entry?.baseTracked !== false) continue;
    const relative = safeRelativePath(entry.path);
    await rm(path.join(reviewerRoot, relative), { recursive: true, force: true });
  }
  await git(reviewerRoot, ["restore", "--source=HEAD", "--staged", "--worktree", "--", "."], options);

  const [changedResult, untrackedResult, baseResult] = await Promise.all([
    git(builderRoot, ["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"], options),
    git(builderRoot, ["ls-files", "--others", "--exclude-standard", "-z"], options),
    git(builderRoot, ["ls-tree", "-r", "--name-only", "-z", "HEAD"], options),
  ]);
  const changed = nulList(changedResult.stdout).map(safeRelativePath);
  const untracked = nulList(untrackedResult.stdout).map(safeRelativePath);
  const baseTracked = new Set(nulList(baseResult.stdout).map(safeRelativePath));
  const paths = [...new Set([...changed, ...untracked])].sort();
  const changedSet = new Set(changed);
  const entries = [];
  for (const relative of paths) {
    entries.push({ ...(await copyEntry(builderRoot, reviewerRoot, relative)), baseTracked: baseTracked.has(relative) });
  }
  const stagedNewPaths = entries
    .filter((entry) => !entry.baseTracked && entry.kind !== "missing" && changedSet.has(entry.path))
    .map((entry) => entry.path);
  if (stagedNewPaths.length) await git(reviewerRoot, ["add", "--", ...stagedNewPaths], options);

  const [builderDiff, reviewerDiff] = await Promise.all([
    git(builderRoot, ["diff", "--binary", "--full-index", "--no-ext-diff", "HEAD", "--"], options),
    git(reviewerRoot, ["diff", "--binary", "--full-index", "--no-ext-diff", "HEAD", "--"], options),
  ]);
  if (builderDiff.stdout !== reviewerDiff.stdout) {
    throw new Error("Reviewer snapshot verification failed: tracked diffs differ from Builder.");
  }

  const untrackedEntries = entries.filter((entry) => !entry.baseTracked);
  const reviewerFingerprints = [];
  for (const entry of untrackedEntries) reviewerFingerprints.push(await entryFingerprint(reviewerRoot, entry));
  const expectedFingerprints = untrackedEntries.map(({ baseTracked: _baseTracked, ...entry }) => entry);
  if (JSON.stringify(expectedFingerprints) !== JSON.stringify(reviewerFingerprints)) {
    throw new Error("Reviewer snapshot verification failed: untracked files differ from Builder.");
  }
  const digest = createHash("sha256")
    .update(builderDiff.stdout)
    .update(JSON.stringify(expectedFingerprints))
    .digest("hex");
  return { head: builderHead.stdout.trim(), digest, entries, changedPaths: changed.length, untrackedPaths: untracked.length };
}
