# Adopt the current Pi session as Orchestrator

Status: implemented behind the disabled-by-default `isolated` launch mode. Do not
change the default to `adopt-current` while the workflow used to develop it is still
running. An `idle` Orchestrator is not sufficient evidence of completion because it
may be waiting for an approval. The gate opens only after its final report is visible
or the user explicitly confirms that the workflow has finished.

## Decision

Make `adopt-current` the default launch mode for an eligible interactive Pi session.
Keep `isolated` as an explicit alternative and as the fallback when adoption cannot
be made safe.

Adoption means that the current Pi process, conversation, pane, and workspace become
the top-level Orchestrator. It does not replace Pi or create a second Orchestrator
workspace. Scout, Builder, and Reviewer remain separate Herdr child workspaces, and
their nested advisers remain inspector panes inside the owning role workspace.

```text
before approval                   after approval

project                           project · orchestrator (same Pi session)
                                  ├── project · scout
                                  ├── project · builder
                                  └── project · reviewer
                                      └── subagent inspector panes
```

## User experience

1. A normal project Pi session discovers `pi-herdr-orchestrator` for a substantial
   task.
2. The skill runs doctor and preflight, explains the two approval boundaries, and
   asks permission to create the workflow.
3. After the user approves, `pi_herdr_orchestrator.start` adopts the current session instead
   of creating another workspace.
4. The approval turn settles. The extension immediately queues the Orchestrator's
   bootstrap message as a new turn in the same conversation. The Orchestrator system
   prompt and policy are active before that turn begins.
5. The Orchestrator may create visible role workspaces, but still asks for separate
   implementation approval before Builder starts.
6. After the final workflow report settles, the extension restores the original Pi
   runtime and workspace identity.

An explicit launch option selects isolation when requested:

```text
launchMode: adopt-current | isolated
```

## Eligibility

Adoption is allowed only when all of the following are true:

- Pi is interactive and running inside Herdr.
- The caller pane and workspace IDs are available from Herdr's injected context.
- The current pane hosts the calling Pi agent and can be resolved unambiguously.
- No workflow role or workflow run is already active in this Pi session.
- No other live workflow owns the same repository and exact task.
- The repository passes the existing clean-snapshot preflight.
- The configured Orchestrator model is available with credentials.
- The workflow, guard, role-appearance, and subagent extensions are already loaded.

If adoption is ineligible, return a precise reason. Fall back to `isolated` only when
the user selected automatic fallback; never silently weaken policy.

## Runtime transition

The Pi extension API supports the required in-process transition:

- `before_agent_start` appends the Orchestrator system prompt before each active
  workflow turn;
- `setActiveTools()` restricts the current session to the configured Orchestrator
  tool set;
- `setModel()` selects the configured provider/model;
- `setThinkingLevel()` selects the configured reasoning level;
- `setSessionName()` identifies the adopted session.

Herdr supplies current pane/workspace identity and can rename both the workspace and
the live agent. The transition must save the original runtime first:

- active tool names;
- provider/model key;
- thinking level;
- Pi session name;
- Herdr workspace label;
- Herdr live agent name;
- session ID, pane ID, and workspace ID used as the adoption lease.

Never persist a model object or credentials. Persist only stable identifiers.

## Dynamic guard

`role-guard` currently becomes inert when no workflow role environment variables
exist at extension load time. Refactor it to register its handlers unconditionally
and resolve a session-scoped role lease at event time.

The lease has three sources, in precedence order:

1. an in-memory activation owned by the current extension instance;
2. a workflow activation custom entry in the resumed Pi session;
3. launch environment variables used by isolated Orchestrator and primary roles.

The lease must match the current Pi session ID and Herdr pane ID. A state file alone
must never promote an unrelated Pi process.

While the lease is active, the guard enforces the same path, mutation, recursion,
delegation, artifact, and authority rules as an isolated Orchestrator. Extra tools
or extensions loaded by the normal Pi session do not gain workflow authority.

## State model

Extend the Orchestrator record without changing the meaning of existing isolated
runs:

```json
{
  "launchMode": "adopt-current",
  "adopted": true,
  "ownsWorkspace": false,
  "activation": {
    "status": "activating",
    "sessionId": "opaque-pi-session-id",
    "workspaceId": "opaque-herdr-workspace-id",
    "paneId": "opaque-herdr-pane-id",
    "original": {
      "tools": [],
      "model": "provider/model",
      "thinking": "level",
      "sessionName": "optional-name",
      "workspaceLabel": "project",
      "agentName": "optional-live-name"
    }
  }
}
```

Use explicit activation states:

```text
activating -> active -> finishing -> restored
           \-> rollback -> failed
```

`closeRole` must never close an adopted Orchestrator workspace. Primary role
ownership and cleanup behavior remain unchanged.

## Atomic activation and rollback

Activation order:

1. validate eligibility and duplicate-run protection;
2. record the clean repository snapshot;
3. persist an `activating` state with the original runtime snapshot;
4. acquire the session/pane lease;
5. switch model, reasoning level, active tools, session name, agent name, and
   workspace label;
6. activate the dynamic guard and prompt injection;
7. persist `active`;
8. queue the bootstrap message for the next turn.

The current approval turn must not begin orchestration under its original system
prompt. Orchestration starts only in the queued turn after activation.

If any step fails, reverse every completed runtime change, release the lease, mark
the run failed, and leave the original conversation usable. A partial adoption must
not create role workspaces.

## Completion and restoration

Introduce an explicit Orchestrator finish transition. It records `finishing` and
allows the Orchestrator to produce its final report under workflow policy. After that
turn reaches `agent_settled`, restore the saved runtime and mark the activation
`restored`.

Restoration must:

- disable Orchestrator prompt injection and the dynamic role lease;
- restore tools, model, reasoning, session name, agent name, and workspace label;
- leave the conversation and workflow history intact;
- preserve workflow state, sessions, and worktrees for inspection;
- avoid closing the adopted workspace or Pi process.

If Pi or Herdr exits before restoration, a resumed matching Pi session reconciles
the activation before its next model turn. A non-matching session reports the stale
lease and requires explicit recovery; it does not adopt automatically.

## Isolated compatibility

The existing isolated path remains supported and semantically unchanged:

- it creates a new Orchestrator workspace and Pi process;
- it owns that workspace;
- role policy comes from launch environment variables;
- it is used when explicitly selected or when safe adoption is unavailable and the
  user approved fallback.

Run-state readers must accept historical records that do not contain `launchMode`,
`adopted`, `ownsWorkspace`, or `activation`; those records mean `isolated`.

## Test plan

Unit tests:

- adoption eligibility and duplicate protection;
- exact activation state transitions;
- session/pane lease matching and stale-lease rejection;
- dynamic prompt injection only while active;
- active tool/model/thinking changes and exact restoration;
- role-guard activation without launch environment variables;
- `closeRole` refusal for an adopted Orchestrator;
- final-report settling before restoration;
- every activation failure point rolls back fully;
- historical isolated state remains readable.

Controller tests with a fake Herdr binary:

- adoption performs no `workspace create` or `agent start`;
- current workspace and agent are renamed from returned IDs, never inferred IDs;
- Scout, Builder, and Reviewer use the adopted workspace as their hierarchy parent;
- `isolated` still performs the existing creation sequence;
- restoration never closes the adopted workspace.

End-to-end validation must use a separate named Herdr test session, never a live user
workflow. It should prove:

- the approval remains in the same Pi conversation and workspace;
- the next turn has the Orchestrator prompt and restricted tools;
- primary roles appear as child workspaces;
- nested subagents appear as inspector panes;
- no `.pi-subagents/` data is written into the target repository;
- the final report restores the original interactive Pi runtime.

## Deferred enablement gate

The implementation and its automated fake-Herdr integration tests are present, but
`config/workflow.json` keeps `isolated` as the configured default. No active Herdr
workspace is migrated. After explicit confirmation that the currently active
workflow has produced its final report, run the end-to-end checks in a separate
Herdr session; only then change the default to `adopt-current`.
