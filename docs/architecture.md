# Architecture

## Components

- `pi-herdr-orchestrator` is the discoverable entry point.
- `pi_herdr_orchestrator` is the deterministic Pi tool for primary workspace lifecycle.
- `role-guard` applies role-aware path and tool policy inside workflow sessions.
- `auto-inspectors` turns every flattened async child into a task-labelled Herdr pane.
- `builder-writers` is a Builder-only control tool for bounded Writer waves.
- `writer-guard` confines a no-shell Writer's file tools to its controller-owned
  detached worktree and rejects `.git` and symlink traversal.
- `writer-wave` owns lane normalization, durable state, worktrees, panes, raw delta
  capture, patch hashing, dry-run integration, and exact Builder transfer.
- `ask-user-question` wraps the pinned questionnaire extension for user-owned
  planning decisions and explicit plan approval.
- `ponytail-builder` injects the pinned Ponytail `full` guidance into Builder only,
  without installing Ponytail's global configuration commands.
- Reviewer alone receives the pinned `ponytail-review` skill as a secondary,
  non-authoritative complexity pass.
- `pi-subagents` supplies nested delegation, missions, FleetView, and Herdr inspector
  panes.
- Packaged `pi-herdr-orchestrator.*` subagents provide bounded read-only child roles.
- Role prompts define authority and output contracts.
- XDG state stores run metadata, sessions, and linked worktrees outside the package.

## Lifecycle

```text
normal Pi + skill
  -> user approves workflow creation
  -> current Pi becomes <project> · orchestrator, or isolated fallback is created
  -> optional child <project> · scout + detached base worktree
  -> grouped user-owned decisions + concrete options
  -> plan + structured explicit implementation approval
  -> <project> · builder + linked task worktree
  -> optional guarded Writer panes + detached lane worktrees
  -> binary patch validation + temporary aggregate integration
  -> Builder semantic reconciliation + whole-task validation
  -> child <project> · reviewer + verified Builder snapshot worktree
  -> same Builder correction when required
  -> same Reviewer full re-review
  -> completion report; no automatic Git publication or cleanup
```

Each main role is a top-level interactive Pi session in a Herdr worktree child
workspace and therefore a legitimate `pi-subagents` parent. Nested children remain
headless. Each automatic pane uses the child's workflow-graph label and flat index to
show a child-specific lifecycle view; it is not an attached child terminal.

Writer panes are different from those inspectors: each is a real subordinate Pi
session running in a controller-created detached worktree. The fixed Writer argv has
`read`, `edit`, `write`, `grep`, `find`, and `ls` only. It loads only `writer-guard`,
with no Bash, subagent tool, project context, skills, prompt templates, or ambient
extensions. The parent Builder is mutation-locked until capture and integration end.

Workflow-role delegation sets `artifacts:false` and `mission:false`. Inspectors use
the asynchronous lifecycle directory and nested Pi sessions remain under the role
session, so project-local `.pi-subagents/` files are unnecessary.

Parallel decomposition is adaptive. Before starting Builder, Orchestrator may derive
disjoint implementation candidates and read-only support candidates from the approved
plan. Before starting Reviewer, it may derive
review candidates from the plan plus Builder's changed-file and validation handoff.
Candidates carry an ID, task label, exact scope, question, evidence contract, and
dependencies. Builder validates them against the repository and Reviewer against the
complete diff; either role may select zero through the configured maximum, reshape
the proposal, or proceed alone. Multiple selected lanes use one asynchronous
`runs.all`, while each flattened child still receives a separate labelled pane.
Completed panes remain available for inspection until that role starts another
fan-out; the extension then closes completed views before allocating the configured
pane budget to the new workflow.

Implementation candidates carry exact write sets in addition to task and acceptance
contracts. The controller supports one pre-mutation wave per clean Builder state. It
walks each lane filesystem, constructs a temporary index with `hash-object
--no-filters`, emits `--binary --full-index --no-ext-diff --no-textconv --no-renames`
patches, hashes them, and refuses any path outside its lane. All patches must apply in
a detached integration worktree before a single combined patch is checked and applied
to Builder. No Git merge, commit, cherry-pick, rebase, or automatic conflict resolution
is used. Failed waves retain evidence and block Reviewer until Builder records manual
reconciliation.

Orchestrator and Builder are separate processes that can update the same workflow
record. State writes therefore use a per-run lock and a three-way merge against the
caller's read snapshot. Disjoint role and Writer-wave changes are preserved; a true
same-field conflict fails closed and must be retried from freshly loaded state.

Reviewer does not share Builder's writable checkout. Before each review the controller
restores its detached checkout, mirrors Builder's tracked diff and non-ignored new
files, then compares binary diffs and fingerprints. This preserves both an independent
workspace and exact handoff evidence.

The role guard registers a session-scoped `pi-subagents` capability ceiling. Only
the three packaged child agents may launch; their effective tools are intersected
with `read`, `grep`, `find`, and `ls`, extensions are denied, and nesting depth is
zero. This enforcement does not depend on a child inheriting the parent extension.

The questionnaire extension loads in normal Pi so `adopt-current` can activate it
without replacing the process. Isolated Orchestrators load the same local wrapper
explicitly. Scout, Builder, Reviewer, and nested subagents never receive the tool.

Ponytail has the inverse placement: normal Pi, Orchestrator, Scout, and nested
subagents do not load it. Builder loads the fixed local guidance adapter, while
Reviewer loads only the review skill. This preserves the main role contracts and
prevents a third-party prompt from changing orchestration or delegation behavior.

Context Mode is not part of the runtime architecture. Its proposed isolated MCP and
policy boundary is documented in the
[Context Mode security design](context-mode-security-design.md).

## Portability boundary

The package resolves every bundled path relative to `import.meta.url`. It contains no
home-directory paths. Host dependencies are intentionally external: Pi, Herdr, Git,
Node.js, and provider credentials. Runtime paths use XDG with standard home-directory
fallbacks.
