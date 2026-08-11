# Pi Herdr Orchestrator

Turn a normal Pi conversation into a visible, role-based coding workflow in Herdr.

`pi-herdr-orchestrator` is intended for substantial coding tasks: multi-file
changes, architectural work, risky migrations, investigations, and iterative
implementation/review. Pi remains the conversational control plane while each
primary role gets a visible Herdr workspace and an isolated Git checkout.

## What it provides

- A persistent **Orchestrator** that investigates, plans, and coordinates the task.
- A read-only **Scout** for independent discovery.
- A **Builder** that is the sole integrator and the only role allowed to change the
  task worktree.
- Optional no-shell **Writer** panes, each guarded inside its own detached worktree,
  for genuinely independent pre-mutation implementation slices.
- A read-only **Reviewer** that inspects a verified snapshot of Builder's exact diff.
- Role-scoped Ponytail guidance for a lean Builder and a separate complexity review.
- Structured decision dialogs that present concrete options while planning.
- Task-labelled Herdr inspector panes for bounded `pi-subagents` delegations.
- Two approval boundaries: one to start discovery and another before implementation.
- No automatic commits, pushes, merges, rebases, deployments, branch deletion, or
  worktree cleanup.

```text
<project> · orchestrator
├── <project> · scout
│   └── subagent inspector panes
├── <project> · builder
│   ├── isolated Writer panes
│   └── read-only subagent inspector panes
└── <project> · reviewer
    └── subagent inspector panes
```

## Requirements

- Node.js 22 or newer
- Pi 0.84.1 or newer
- Herdr 0.8.0 or newer
- Git
- A working provider configuration in Pi

Start the workflow from a Pi session running inside Herdr (`HERDR_ENV=1`). Provider
credentials stay in your normal Pi configuration and are never copied into this
package.

## Install

With a GitHub SSH key:

```bash
pi install git:git@github.com:0865marc/pi-herdr-orchestrator
```

For a public repository clone:

```bash
pi install git:github.com/0865marc/pi-herdr-orchestrator
```

That is the complete installation for normal use. `pi install` fetches the package,
installs its npm dependencies, and registers its extensions and skill. You do not
also need to run `npm install`.

Start a new Pi session after installation, or run `/reload` in an existing one.
`pi-herdr-orchestrator` should then appear under **Skills**.

### Local development install

Use this only when developing the package itself:

```bash
git clone git@github.com:0865marc/pi-herdr-orchestrator.git
cd pi-herdr-orchestrator
npm install
npm run check
pi install .
```

A local-path installation is live: newly started or reloaded Pi sessions read the
current checkout. A Git installation gives you an explicit update boundary.

## Use it in a project

1. Open the project in Herdr.
2. Start Pi normally in the project pane.
3. Describe the substantial task you want completed.
4. Let Pi discover the skill, or invoke it explicitly:

```text
/skill:pi-herdr-orchestrator
```

The skill runs environment diagnostics and Git preflight first. It explains the
configured launch mode and asks whether it may start the workflow. This first
approval authorizes read-only discovery only. The Orchestrator then presents its
plan and asks again before starting Builder or creating the writable task worktree.

Startup is idempotent: if the same workflow is already live, Pi points you to its
Orchestrator instead of creating a duplicate.

## Adaptive parallelism

The Orchestrator uses the approved plan and role handoffs to propose concrete
`Parallel implementation candidates`, `Parallel support candidates`, and
`Parallel review candidates`. Generic fixed lanes are not imposed.

Builder checks writable and support proposals against the repository; Reviewer checks
review proposals against the complete real diff. Either role may merge, replace, add,
or reject candidates and may launch anywhere from zero to the configured limit.

Writable candidates additionally declare mutually disjoint `write_set` paths. Before
Builder's first mutation, the controller can create one detached worktree and one
task-labelled Pi pane per accepted lane. Those Writers have only guarded read/edit/
write/search tools—no Bash, Git, delegation, skills, network tools, or ambient
extensions. Builder remains read-only until every lane settles. The controller then:

1. captures raw filesystem changes through a temporary Git index without executing
   repository filters;
2. rejects out-of-scope paths, drift, overlap, tampering, oversized deltas, and
   unsupported Git links;
3. emits hashed binary/full-index patches;
4. applies all patches first in a temporary integration worktree; and
5. applies one verified combined patch to Builder's task worktree.

Builder inspects and semantically reconciles the aggregate, completes sequential work,
and runs whole-task validation. Dirty correction rounds remain sequential or use
read-only support lanes. A failed wave never auto-merges or auto-resolves conflicts;
its evidence and worktrees remain available for explicit reconciliation.

Every read-only child in a parallel workflow gets its own inspector pane inside the owning role workspace,
named from the task label, for example `subagent · course migration`. The default
limit is three panes per primary role. Completed panes remain visible until the next
fan-out starts, when they are replaced by the new task-labelled views.

## Interactive planning

The package includes
[`@juicesharp/rpiv-ask-user-question`](https://pi.dev/packages/@juicesharp/rpiv-ask-user-question)
for decisions that genuinely belong to you. Instead of silently choosing an
architecture, compatibility strategy, migration scope, or risk trade-off, the
Orchestrator groups up to four related questions into one terminal dialog and shows
2–4 explained options for each.

The recommended option appears first, but every question also accepts a custom
answer or an attached note. The Orchestrator uses a final questionnaire with these
choices before Builder starts:

- **Approve plan (Recommended)** — implement the plan as presented.
- **Request changes** — revise it and request approval again.
- **Stop workflow** — do not create the writable worktree.

Use arrow keys and `Enter` to select, `Tab` to move between questions, `n` to attach
a note, or `Esc` to cancel. A cancellation or UI failure never counts as approval;
the Orchestrator falls back to a plain chat question and waits.

## Role-scoped Ponytail

The package pins
[`@dietrichgebert/ponytail`](https://pi.dev/packages/@dietrichgebert/ponytail)
to `4.9.0`, but does not load it globally:

- Builder receives Ponytail's `full` implementation guidance through a local adapter.
  The adapter does not expose Ponytail commands that can change global user config.
- Reviewer discovers only the bundled `ponytail-review` skill and uses it after its
  normal correctness, security, and plan-compliance pass.
- normal Pi, Orchestrator, Scout, and nested subagents receive neither behavior.

No separate Ponytail installation is needed. Updating it is an intentional repository
change: review the new release, change the exact dependency, run the suite, and update
the lockfile.

## Orchestrator launch modes

Choose the launch mode in [`config/workflow.json`](config/workflow.json):

```json
{
  "orchestratorLaunchMode": "isolated"
}
```

- `isolated` is the current default. It creates a dedicated
  `<project> · orchestrator` workspace and leaves the originating chat idle.
- `adopt-current` promotes the current Pi conversation and Herdr workspace into the
  Orchestrator. When the workflow finishes, it restores the original model, tools,
  reasoning level, session name, and workspace labels. This mode is implemented but
  remains opt-in while it receives end-to-end validation.

Override the mode per machine without editing the repository:

```bash
export PI_HERDR_ORCHESTRATOR_LAUNCH_MODE=adopt-current
```

You can configure provider and role models in the same way:

```bash
export PI_HERDR_ORCHESTRATOR_PROVIDER=openai-codex
export PI_HERDR_ORCHESTRATOR_ORCHESTRATOR_MODEL=gpt-5.6-sol
export PI_HERDR_ORCHESTRATOR_BUILDER_MODEL=gpt-5.6-luna
export PI_HERDR_ORCHESTRATOR_REVIEWER_MODEL=gpt-5.6-luna
export PI_HERDR_ORCHESTRATOR_SCOUT_MODEL=gpt-5.6-luna
```

## Runtime data and safety

Bundled resources are resolved relative to the package, so the repository contains
no machine-specific home paths. Runtime state and linked worktrees live outside the
installation:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/pi-herdr-orchestrator/runs/
${XDG_DATA_HOME:-$HOME/.local/share}/pi-herdr-orchestrator/worktrees/
${XDG_DATA_HOME:-$HOME/.local/share}/pi-herdr-orchestrator/writer-waves/
```

Only Builder receives write-capable tools for the task checkout. Isolated Writers can
edit only their separate guarded worktrees, and controller validation is authoritative
over their declared `write_set`. Scout, Reviewer, and packaged `pi-subagents` children
remain restricted to read/search tools. Reviewer gets a detached
checkout populated from Builder's tracked diff and non-ignored new files; the
controller verifies the diff and file fingerprints before every review.

The questionnaire extension is pinned to version `2.4.0`. It makes no model or
network calls of its own. It reads optional user configuration and launches Pi's
configured external editor only when you explicitly request that from the dialog.

Context Mode is intentionally **not installed or enabled**. Its command, network,
indexing, and maintenance surface needs a dedicated role boundary before it can safely
join this workflow. See the separate
[Context Mode security design](docs/context-mode-security-design.md) for the proposed
tool matrix, isolation model, rollout, and acceptance gates.

The Writer guard rejects absolute paths, parent traversal, `.git`, and existing
symlink traversal, but Pi does not provide an operating-system sandbox and same-user
filesystem checks cannot eliminate every TOCTOU risk. Read the
[security notes](docs/security.md) before running untrusted code or unattended tasks.

## Update

Update installed Pi packages with:

```bash
pi update --extensions
```

Restart Pi or run `/reload` afterward. If you installed a pinned tag or commit,
install the desired new ref explicitly.

## Development

Run the complete validation suite before publishing changes:

```bash
npm install
npm run check
```

The suite checks extension imports and syntax, path portability, skill metadata,
policy behavior, Git snapshot fidelity, binary Writer patch round-trips, path and
write-set restrictions, inspector panes, and both Orchestrator launch modes.

Further reading:

- [Architecture](docs/architecture.md)
- [Security model](docs/security.md)
- [Context Mode security design](docs/context-mode-security-design.md)
- [Adopt-current design and rollout](docs/adopt-current-orchestrator.md)
