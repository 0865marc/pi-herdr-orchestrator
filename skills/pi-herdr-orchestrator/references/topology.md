# Pi Herdr Orchestrator topology

Herdr renders a real parent/child hierarchy only for Git worktree groups. The
controller registers every primary-role checkout through `herdr worktree open`, so
the Orchestrator is the parent and the primary roles appear underneath it:

```text
<project> · orchestrator
├── <project> · scout      detached clean-base checkout
│   └── automatic read-only inspector panes
├── <project> · builder    task branch; the only writer
│   └── automatic read-only inspector panes
└── <project> · reviewer   verified snapshot of Builder's diff
    └── automatic read-only inspector panes
```

Main roles are independent interactive Pi sessions. This makes each role a valid
`pi-subagents` parent while preventing an ordinary headless child from becoming a
second control plane.

Pi subagents remain headless. Workflow roles must launch them through asynchronous
`workflowScript`; an extension listens for the durable start event and opens a
read-only Herdr inspector automatically. Closing an inspector does not stop its run.
Use at most three simultaneous inspector panes per role.

The Builder workspace owns the task worktree. Reviewer uses a separate detached
checkout populated from Builder's tracked diff and non-ignored new files; the
controller compares the resulting binary Git diff and file fingerprints before every
review. Scout uses an independent detached checkout of the approved clean base.
