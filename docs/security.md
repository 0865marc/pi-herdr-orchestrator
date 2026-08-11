# Security model

Pi has no built-in operating-system sandbox. This package provides defense in depth,
not a hard privilege boundary.

## Enforced in the package

- Only the owning Orchestrator can start, prompt, wait for, read, or close main roles.
- Active workflow roles cannot recursively start another workflow, and duplicate
  starts for the same live task reuse the existing Orchestrator.
- Mutating workspace actions require explicit `approved: true`.
- Tool paths are constrained to the assigned role root.
- Read-only access to this package is allowed so roles can load bundled skill
  references; writes remain confined to the assigned role root.
- Orchestrator and Scout cannot use general Bash or mutation tools.
- Reviewer cannot write and Bash is limited to configured read-only/test prefixes.
- A `pi-subagents` capability ceiling restricts all nested agents to three packaged
  read-only definitions, four read/search tools, no extra extensions, and no further
  nesting; the top-level Builder is the single writer.
- Builder Bash blocks common destructive, history-changing, privilege, and publishing
  patterns.
- Child processes are launched without a shell by the controller.
- Nested delegation must use asynchronous `workflowScript`; inspector panes are
  opened automatically and are read-only.
- Nested calls disable project artifacts and automatic missions. Durable role
  sessions and asynchronous lifecycle state remain outside the target repository,
  which therefore receives no `.pi-subagents/` bookkeeping.
- Automatic commits, pushes, merges, rebases, publication, deployment, worktree
  removal, and branch deletion are absent by design.

## Not a hard boundary

Shell pattern filtering cannot fully interpret every executable or project script.
Tests and build tools can themselves modify files. Pi extensions execute with the
user's permissions. For untrusted repositories or unattended execution, run the Pi
role processes inside a container, VM, micro-VM, or OS policy sandbox with minimal
mounts and credentials.

Credentials, sessions, runtime state, worktrees, and local approvals must never be
committed to this repository.
