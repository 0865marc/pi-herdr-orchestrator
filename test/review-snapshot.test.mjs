import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDetachedWorktree, createLinkedWorktree } from "../src/git.mjs";
import { runChecked } from "../src/process.mjs";
import { syncReviewSnapshot } from "../src/review-snapshot.mjs";

test("Reviewer worktree mirrors and verifies Builder corrections", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "herdr-review-snapshot-"));
  const repository = path.join(base, "repo");
  const builder = path.join(base, "builder");
  const reviewer = path.join(base, "reviewer");
  await runChecked("git", ["init", "-b", "main", repository]);
  await runChecked("git", ["-C", repository, "config", "user.email", "test@example.invalid"]);
  await runChecked("git", ["-C", repository, "config", "user.name", "Workflow Test"]);
  await writeFile(path.join(repository, "README.md"), "base\n");
  await writeFile(path.join(repository, "remove.txt"), "remove me\n");
  await runChecked("git", ["-C", repository, "add", "."]);
  await runChecked("git", ["-C", repository, "commit", "-m", "fixture"]);
  const head = (await runChecked("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
  await createLinkedWorktree({ root: repository, branch: "task/test", base: head, worktreePath: builder });
  await createDetachedWorktree({ root: repository, base: head, worktreePath: reviewer });

  await writeFile(path.join(builder, "README.md"), "builder change\n");
  await rm(path.join(builder, "remove.txt"));
  await writeFile(path.join(builder, "new.txt"), "new untracked file\n");
  await writeFile(path.join(builder, "staged.txt"), "new staged file\n");
  await runChecked("git", ["-C", builder, "add", "staged.txt"]);
  const first = await syncReviewSnapshot({ builderRoot: builder, reviewerRoot: reviewer });
  assert.equal(await readFile(path.join(reviewer, "README.md"), "utf8"), "builder change\n");
  await assert.rejects(access(path.join(reviewer, "remove.txt")));
  assert.equal(await readFile(path.join(reviewer, "new.txt"), "utf8"), "new untracked file\n");
  assert.equal(await readFile(path.join(reviewer, "staged.txt"), "utf8"), "new staged file\n");
  assert.equal(first.changedPaths, 3);
  assert.equal(first.untrackedPaths, 1);

  await writeFile(path.join(builder, "README.md"), "corrected\n");
  await rm(path.join(builder, "new.txt"));
  await runChecked("git", ["-C", builder, "restore", "--staged", "staged.txt"]);
  await rm(path.join(builder, "staged.txt"));
  await writeFile(path.join(builder, "replacement.txt"), "replacement\n");
  const second = await syncReviewSnapshot({
    builderRoot: builder,
    reviewerRoot: reviewer,
    previousEntries: first.entries,
  });
  assert.notEqual(second.digest, first.digest);
  assert.equal(await readFile(path.join(reviewer, "README.md"), "utf8"), "corrected\n");
  await assert.rejects(access(path.join(reviewer, "new.txt")));
  assert.equal(await readFile(path.join(reviewer, "replacement.txt"), "utf8"), "replacement\n");
});
