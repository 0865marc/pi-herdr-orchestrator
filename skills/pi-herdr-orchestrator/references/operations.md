# Pi Herdr Orchestrator operations and recovery

## Preconditions

- `pi`, `herdr`, `git`, and Node.js are available.
- Package dependencies were installed by Pi or `npm install`.
- The caller is inside Herdr.
- The base repository is clean and on a branch.
- Provider authentication exists in the host Pi configuration; credentials are not
  part of this package.

## Control actions

The `pi_herdr_orchestrator` tool exposes:

- `doctor` and `preflight`: read-only diagnostics.
- `start`: adopt the current Pi or create an isolated Orchestrator after explicit
  approval, according to the configured launch mode.
- `start_role`: create Scout, Builder, or Reviewer after explicit approval.
- `prompt_role`, `wait_role`, and `read_role`: coordinate an existing role.
- `status`: combine stored workflow state, live Herdr state, and Git snapshots.
- `close_role`: close Scout, Builder, or Reviewer after explicit approval. It never
  removes the Builder worktree or branch.
- `finish`: mark the final Orchestrator report. Adopted sessions restore their
  original model, tools, reasoning, names, and workspace label after that turn
  settles.

`start` is idempotent for the same repository and task while its Orchestrator remains
live. Active workflow roles are forbidden from calling it, which prevents recursive
Orchestrator workspaces.

## Runtime state

No runtime state is written into this package. State defaults to:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/pi-herdr-orchestrator/runs/
${XDG_DATA_HOME:-$HOME/.local/share}/pi-herdr-orchestrator/worktrees/
```

Role sessions are stored beside workflow run state. Scout and Reviewer have detached
role worktrees; Builder has the task-branch worktree. Authentication remains in the
user's normal Pi configuration.

## Failure behavior

Creation failures preserve workspaces and worktrees for inspection. Unknown Herdr
state is never treated as completion. Cleanup is manual and requires explicit user
authority; do not infer permission to discard uncommitted work.
