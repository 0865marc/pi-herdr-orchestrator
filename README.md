# Pi Herdr Orchestrator

Turn a normal Pi conversation into a visible, role-based coding workflow in Herdr.

`pi-herdr-orchestrator` is intended for substantial coding tasks: multi-file
changes, architectural work, risky migrations, investigations, and iterative
implementation/review. Pi remains the conversational control plane while each
primary role gets a visible Herdr workspace and an isolated Git checkout.

## What it provides

- A persistent **Orchestrator** that investigates, plans, and coordinates the task.
- A read-only **Scout** for independent discovery.
- A **Builder** that is the only role allowed to change the task worktree.
- A read-only **Reviewer** that inspects a verified snapshot of Builder's exact diff.
- Structured decision dialogs that present concrete options while planning.
- Automatic Herdr inspector panes for bounded `pi-subagents` delegations.
- Two approval boundaries: one to start discovery and another before implementation.
- No automatic commits, pushes, merges, rebases, deployments, branch deletion, or
  worktree cleanup.

```text
<project> · orchestrator
├── <project> · scout
│   └── subagent inspector panes
├── <project> · builder
│   └── subagent inspector panes
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
```

Only Builder receives write-capable tools for the task checkout. Scout, Reviewer,
and packaged subagents are restricted to read/search tools. Reviewer gets a detached
checkout populated from Builder's tracked diff and non-ignored new files; the
controller verifies the diff and file fingerprints before every review.

The questionnaire extension is pinned to version `2.4.0`. It makes no model or
network calls of its own. It reads optional user configuration and launches Pi's
configured external editor only when you explicitly request that from the dialog.

Pi does not provide an operating-system sandbox. Read the
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
policy behavior, Git snapshot fidelity, subagent restrictions, inspector panes, and
both Orchestrator launch modes.

Further reading:

- [Architecture](docs/architecture.md)
- [Security model](docs/security.md)
- [Adopt-current design and rollout](docs/adopt-current-orchestrator.md)
