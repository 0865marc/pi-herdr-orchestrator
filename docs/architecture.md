# Architecture

## Components

- `pi-herdr-orchestrator` is the discoverable entry point.
- `herdr_workflow` is the deterministic Pi tool for primary workspace lifecycle.
- `role-guard` applies role-aware path and tool policy inside workflow sessions.
- `auto-inspectors` turns every async child-run event into a visible Herdr pane.
- `pi-subagents` supplies nested delegation, missions, FleetView, and Herdr inspector
  panes.
- Packaged `herdr-workflow.*` subagents provide bounded read-only child roles.
- Role prompts define authority and output contracts.
- XDG state stores run metadata, sessions, and linked worktrees outside the package.

## Lifecycle

```text
normal Pi + skill
  -> user approves workflow creation
  -> current Pi becomes <project> · orchestrator, or isolated fallback is created
  -> optional child <project> · scout + detached base worktree
  -> plan + explicit implementation approval
  -> <project> · builder + linked task worktree
  -> child <project> · reviewer + verified Builder snapshot worktree
  -> same Builder correction when required
  -> same Reviewer full re-review
  -> completion report; no automatic Git publication or cleanup
```

Each main role is a top-level interactive Pi session in a Herdr worktree child
workspace and therefore a legitimate `pi-subagents` parent. Nested children remain
headless. Their automatic inspector panes are views into lifecycle artifacts, not
attached child terminals.

Workflow-role delegation sets `artifacts:false` and `mission:false`. Inspectors use
the asynchronous lifecycle directory and nested Pi sessions remain under the role
session, so project-local `.pi-subagents/` files are unnecessary.

Reviewer does not share Builder's writable checkout. Before each review the controller
restores its detached checkout, mirrors Builder's tracked diff and non-ignored new
files, then compares binary diffs and fingerprints. This preserves both an independent
workspace and exact handoff evidence.

The role guard registers a session-scoped `pi-subagents` capability ceiling. Only
the three packaged child agents may launch; their effective tools are intersected
with `read`, `grep`, `find`, and `ls`, extensions are denied, and nesting depth is
zero. This enforcement does not depend on a child inheriting the parent extension.

## Portability boundary

The package resolves every bundled path relative to `import.meta.url`. It contains no
home-directory paths. Host dependencies are intentionally external: Pi, Herdr, Git,
Node.js, and provider credentials. Runtime paths use XDG with standard home-directory
fallbacks.
