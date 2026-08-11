import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runChecked } from "../src/process.mjs";
import { assertBuilderWriterAuthority, captureWriterBaseline, captureWriterDelta, normalizeWriterLanes, writerWaveBlocksReview, writerWaveIsActive } from "../src/writer-wave.mjs";
import { writerPathViolation } from "../extensions/writer-guard.ts";

async function git(cwd, args, options = {}) {
  return runChecked("git", ["-C", cwd, ...args], options);
}

test("writer candidates require bounded disjoint exact write sets", () => {
  const lanes = normalizeWriterLanes([
    { id: "api", label: "API", scope: "server API", write_set: ["src/api/", "test/api.test.ts"], task: "implement API", acceptance: "tests cover behavior", depends_on: [] },
    { id: "ui", label: "UI", scope: "admin UI", write_set: ["src/ui/"], task: "implement UI", acceptance: "renders state", depends_on: [] },
  ], 3);
  assert.deepEqual(lanes.map((lane) => lane.id), ["api", "ui"]);
  assert.deepEqual(lanes[0].writeSet, ["src/api/", "test/api.test.ts"]);
  assert.throws(() => normalizeWriterLanes([
    { id: "a", label: "A", scope: "a", write_set: ["src/"], task: "a", acceptance: "a" },
    { id: "b", label: "B", scope: "b", write_set: ["src/file.ts"], task: "b", acceptance: "b" },
  ]), /overlap/u);
  assert.throws(() => normalizeWriterLanes([
    { id: "a", label: "A", scope: "a", write_set: ["Src/"], task: "a", acceptance: "a" },
    { id: "b", label: "B", scope: "b", write_set: ["src/file.ts"], task: "b", acceptance: "b" },
  ]), /overlap/u);
  assert.throws(() => normalizeWriterLanes([{ id: "a", label: "A", scope: "a", write_set: ["../escape"], task: "a", acceptance: "a" }]), /Unsafe/u);
  assert.throws(() => normalizeWriterLanes([{ id: "a", label: "A", scope: "a", write_set: [".git/config"], task: "a", acceptance: "a" }]), /administrative/u);
  assert.throws(() => normalizeWriterLanes([{ id: "a", label: "A", scope: "a", write_set: ["src/*.ts"], task: "a", acceptance: "a" }]), /globs/u);
  assert.throws(() => normalizeWriterLanes([{ id: "a", label: "bad\nlabel", scope: "a", write_set: ["src/a"], task: "a", acceptance: "a" }]), /requires label/u);
  assert.throws(() => normalizeWriterLanes([{ id: "a", label: "A", scope: "a", write_set: ["src/a"], task: "a", acceptance: "a", depends_on: ["b"] }]), /dependencies/u);
});

test("Builder writer authority requires exact Herdr pane and workspace identity", () => {
  const state = { id: "run", roles: { builder: { cwd: "/repo", paneId: "w1:p2", workspaceId: "w1" } } };
  const base = { PI_HERDR_ORCHESTRATOR_ROLE: "builder", PI_HERDR_ORCHESTRATOR_RUN_ID: "run", PI_HERDR_ORCHESTRATOR_ROLE_ROOT: "/repo" };
  assert.throws(() => assertBuilderWriterAuthority(state, base, "/repo"), /pane/u);
  assert.doesNotThrow(() => assertBuilderWriterAuthority(state, { ...base, HERDR_PANE_ID: "w1:p2", HERDR_WORKSPACE_ID: "w1" }, "/repo"));
});

test("writer guard blocks absolute, parent, Git, and symlink escapes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-herdr-writer-guard-"));
  const outside = await mkdtemp(path.join(tmpdir(), "pi-herdr-writer-outside-"));
  await mkdir(path.join(root, "src"));
  await symlink(outside, path.join(root, "src", "escape"));
  assert.equal(writerPathViolation(root, "src/file.ts"), null);
  assert.match(writerPathViolation(root, "../outside"), /outside/u);
  assert.match(writerPathViolation(root, outside), /relative/u);
  assert.match(writerPathViolation(root, path.join(root, "src", "file.ts")), /relative/u);
  assert.match(writerPathViolation(root, ".git/config"), /administrative/u);
  assert.match(writerPathViolation(root, "src/escape/file.ts"), /symlinks/u);
});

test("writer wave states gate mutation and review independently", () => {
  const state = (status) => ({ parallelImplementation: { waves: [{ id: "wave", status }] } });
  assert.equal(writerWaveIsActive(state("running")), true);
  assert.equal(writerWaveIsActive(state("needs_reconciliation")), false);
  assert.equal(writerWaveBlocksReview(state("needs_reconciliation")), true);
  assert.equal(writerWaveBlocksReview(state("integrated")), false);
});

test("controller capture round-trips binary, text, new, deleted, and mode changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-herdr-writer-capture-"));
  const repository = path.join(root, "repo");
  const lane = path.join(root, "lane");
  const integration = path.join(root, "integration");
  const artifact = path.join(root, "artifacts", "lane.patch");
  await mkdir(path.join(repository, "src"), { recursive: true });
  await git(root, ["init", repository]);
  await git(repository, ["config", "user.email", "test@example.com"]);
  await git(repository, ["config", "user.name", "Test"]);
  await writeFile(path.join(repository, "src", "text.txt"), "before\n");
  await writeFile(path.join(repository, "binary.dat"), Buffer.from([0, 1, 2, 3, 255]));
  await writeFile(path.join(repository, "delete.txt"), "delete me\n");
  await writeFile(path.join(repository, "mode.sh"), "#!/bin/sh\nexit 0\n");
  await git(repository, ["add", "-A"]);
  await git(repository, ["commit", "-m", "base"]);
  const head = (await git(repository, ["rev-parse", "HEAD"])).stdout.trim();
  await git(repository, ["worktree", "add", "--detach", lane, head]);
  await writeFile(path.join(lane, "src", "text.txt"), "after\n");
  await writeFile(path.join(lane, "binary.dat"), Buffer.from([0, 9, 8, 7, 255, 4]));
  await rm(path.join(lane, "delete.txt"));
  await chmod(path.join(lane, "mode.sh"), 0o755);
  await mkdir(path.join(lane, "new"));
  await writeFile(path.join(lane, "new", "file.txt"), "new\n");

  const captured = await captureWriterDelta({
    worktree: lane,
    base: head,
    writeSet: ["src/", "binary.dat", "delete.txt", "mode.sh", "new/"],
    patchPath: artifact,
    maxFiles: 20,
    maxPatchBytes: 1024 * 1024,
  });
  assert.deepEqual(captured.changedPaths, ["binary.dat", "delete.txt", "mode.sh", "new/file.txt", "src/text.txt"]);
  assert.match(await readFile(artifact, "utf8"), /GIT binary patch/u);
  assert.equal((await lstat(artifact)).isFile(), true);

  await git(repository, ["worktree", "add", "--detach", integration, head]);
  await git(integration, ["apply", "--check", "--binary", artifact]);
  await git(integration, ["apply", "--binary", artifact]);
  assert.equal(await readFile(path.join(integration, "src", "text.txt"), "utf8"), "after\n");
  assert.deepEqual(await readFile(path.join(integration, "binary.dat")), Buffer.from([0, 9, 8, 7, 255, 4]));
  await assert.rejects(readFile(path.join(integration, "delete.txt")), /ENOENT/u);
  assert.equal((await lstat(path.join(integration, "mode.sh"))).mode & 0o111, 0o111);
  assert.equal(await readFile(path.join(integration, "new", "file.txt"), "utf8"), "new\n");
});

test("controller capture rejects changes outside write_set without creating an applicable handoff", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-herdr-writer-scope-"));
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "allowed.txt"), "base\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "base"]);
  const head = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  await writeFile(path.join(root, "outside.txt"), "bad\n");
  await assert.rejects(captureWriterDelta({
    worktree: root,
    base: head,
    writeSet: ["allowed.txt"],
    patchPath: path.join(root, "handoff.patch"),
    maxFiles: 20,
    maxPatchBytes: 1024 * 1024,
  }), /outside its declared write_set/u);
});

test("raw baselines avoid false changes and preserve CRLF checkout bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-herdr-writer-raw-baseline-"));
  const repository = path.join(root, "repo");
  const lane = path.join(root, "lane");
  await git(root, ["init", repository]);
  await git(repository, ["config", "user.email", "test@example.com"]);
  await git(repository, ["config", "user.name", "Test"]);
  await writeFile(path.join(repository, ".gitattributes"), "*.txt text eol=crlf\n");
  await writeFile(path.join(repository, "content.txt"), "one\ntwo\n");
  await git(repository, ["add", "-A"]);
  await git(repository, ["commit", "-m", "base"]);
  const head = (await git(repository, ["rev-parse", "HEAD"])).stdout.trim();
  await git(repository, ["worktree", "add", "--detach", lane, head]);
  assert.deepEqual(await readFile(path.join(lane, "content.txt")), Buffer.from("one\r\ntwo\r\n"));
  const baseline = await captureWriterBaseline({ worktree: lane, indexPath: path.join(root, "baseline.index") });
  const empty = await captureWriterDelta({
    worktree: lane,
    baselineTree: baseline.tree,
    writeSet: ["content.txt"],
    patchPath: path.join(root, "empty.patch"),
    maxFiles: 10,
    maxPatchBytes: 1024 * 1024,
  });
  assert.deepEqual(empty.changedPaths, []);
  assert.equal(empty.bytes, 0);
  await writeFile(path.join(lane, "content.txt"), "one\r\ntwo\r\nthree\r\n");
  const changed = await captureWriterDelta({
    worktree: lane,
    baselineTree: baseline.tree,
    writeSet: ["content.txt"],
    patchPath: path.join(root, "changed.patch"),
    maxFiles: 10,
    maxPatchBytes: 1024 * 1024,
  });
  assert.deepEqual(changed.changedPaths, ["content.txt"]);
  assert.ok(changed.bytes > 0);
});
