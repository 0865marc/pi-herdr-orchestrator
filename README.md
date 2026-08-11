# Herdr Pi Workflow

Portable, Pi-first orchestration for long coding tasks. It can promote the current Pi
conversation into the visible Orchestrator, creates one child Herdr workspace per
primary role, and uses `pi-subagents` inspector panes for substantial nested
delegation.

This repository is source-only. Creating or cloning it does not install or activate
anything.

## Topology

```text
<project> · orchestrator   Pi control plane
├── <project> · scout      detached clean-base discovery worktree
├── <project> · builder    only writer; owns task-branch worktree
└── <project> · reviewer   verified read-only Builder snapshot
```

Each role may launch one of three bundled read-only Pi subagents. A session capability
ceiling enforces their agent names, read/search-only tools, extension denial, and zero
nesting depth. Role delegation is asynchronous and each run automatically opens a
Herdr inspector pane inside its parent's workspace. Builder remains the only writer
for the task worktree.

## Requirements

- Node.js 22 or newer.
- Pi 0.84.1 or newer.
- Herdr 0.8.0 or newer.
- Git.
- Provider authentication configured in the host Pi installation.

## Validate the source tree

```bash
npm install
npm run check
```

## Install later

Local development installation:

```bash
pi install /absolute/path/to/herdr-workflow
```

Git installation after publishing:

```bash
pi install git:github.com/OWNER/herdr-workflow@TAG
```

Pi installs the package dependencies, discovers `herdr-long-workflow`, and loads the
three extensions. `role-guard` and `auto-inspectors` are inert outside sessions carrying
`HERDR_WORKFLOW_ROLE`; the controller tool performs no action until explicitly called.

A local-path installation is a live development reference: newly started Pi
processes read the current files immediately. A Git tag or registry version provides
an explicit update boundary.

Run normal Pi inside a Herdr pane and describe a substantial task. The skill may be
selected implicitly, or explicitly invoke:

```text
/skill:herdr-long-workflow
```

The skill runs diagnostics and preflight, explains whether it will adopt this chat or
create an isolated workspace, and asks before starting. Implementation still requires
a separate approval from the Orchestrator.

## Configuration

Edit [`config/workflow.json`](config/workflow.json) to change models, reasoning,
tools, timeouts, launch mode, or policy. `orchestratorLaunchMode` remains `isolated`
while adoption is staged; after validation it can be changed to `adopt-current`.
Override settings per machine without changing the repo:

```bash
export HERDR_WORKFLOW_PROVIDER=openai-codex
export HERDR_WORKFLOW_LAUNCH_MODE=isolated
export HERDR_WORKFLOW_ORCHESTRATOR_MODEL=gpt-5.6-sol
export HERDR_WORKFLOW_BUILDER_MODEL=gpt-5.6-luna
export HERDR_WORKFLOW_REVIEWER_MODEL=gpt-5.6-luna
export HERDR_WORKFLOW_SCOUT_MODEL=gpt-5.6-luna
```

Runtime files are external:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/herdr-workflow/runs/
${XDG_DATA_HOME:-$HOME/.local/share}/herdr-workflow/worktrees/
```

Credentials remain in the user's normal Pi configuration and are never copied into
this repository.

## Safety and cleanup

The controller never commits, pushes, merges, rebases, deletes branches, removes
worktrees, publishes, or deploys. Closing a role workspace preserves its branch and
worktree. Cleanup remains an explicit manual operation after inspecting uncommitted
state.

Pi has no built-in OS sandbox. Read [`docs/security.md`](docs/security.md) before using
the workflow on untrusted code or unattended tasks.
