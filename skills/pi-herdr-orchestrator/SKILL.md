---
name: pi-herdr-orchestrator
description: Route substantial coding work through a portable Pi-first Herdr workflow with a visible project Orchestrator workspace, separate Scout/Builder/Reviewer workspaces, isolated Git worktrees, independent review, and Pi subagent inspector panes. Use for long, multi-file, cross-cutting, risky, research-heavy, or multi-stage implementation tasks that benefit from planning, delegation, validation, and review. Do not use for quick questions, tiny edits, one-file mechanical changes, or tasks that do not justify creating workspaces and a worktree.
---

# Pi Herdr Orchestrator

Use the `pi_herdr_orchestrator` tool as the deterministic control surface. Do not reproduce
workspace, process, or Git orchestration with ad-hoc shell commands.

## Start safely

1. Confirm the session runs inside Herdr. If `HERDR_ENV=1` is unavailable, explain
   that the workflow cannot start from this session and stop.
2. Call `pi_herdr_orchestrator` with `action: "doctor"`.
3. Call `pi_herdr_orchestrator` with `action: "preflight"` for the current repository.
4. Require a clean branch with a non-detached HEAD. Report dirty paths without
   stashing, committing, cleaning, or deleting them.
5. Read `orchestratorLaunchMode` from doctor. Explain that `adopt-current` promotes
   this same conversation/workspace, while `isolated` creates a new
   `<project> · orchestrator` workspace. Neither mode authorizes implementation.
6. Ask for explicit approval before creating or adopting the workflow.
7. Only after approval, call `pi_herdr_orchestrator` with:

```json
{
  "action": "start",
  "repository": "/absolute/repository/path",
  "task": "the complete user task",
  "approved": true,
  "focus": true
}
```

When the result has `adoptionPending: true`, do not tell the user to change
workspaces: the extension queues the Orchestrator bootstrap turn in this same chat.
For `isolated`, return the run ID and tell the user to continue in the new
Orchestrator workspace.
If the tool reports `reused: true`, do not start again: point the user to the existing
Orchestrator.

## Preserve the authority boundary

- Treat approval to create the workflow as permission for read-only discovery only.
- Let the new Orchestrator present an implementation plan and obtain a second,
  explicit approval before it starts Builder or creates a worktree.
- Never commit, push, merge, rebase, delete a branch, remove a worktree, publish,
  deploy, or close the Orchestrator automatically.
- Do not start another workflow from an active workflow role.

## Load details only when needed

- Read [references/topology.md](references/topology.md) when explaining workspace,
  role, or inspector-pane layout.
- Read [references/operations.md](references/operations.md) when diagnosing startup,
  status, role control, cleanup, or portability.
