# Context Mode security design

## Status

**Design only. Context Mode is not installed, registered, or enabled.** This document
defines the conditions that a later opt-in implementation must satisfy. It is not an
authorization to modify `~/.pi/agent/mcp.json`, install a global executable, fetch
network content, run a dashboard, or expose any `ctx_*` tool to an agent.

The design was evaluated against Context Mode `1.0.169`. A future implementation
must repeat the source, dependency, license, and behavior review for the exact version
it proposes to pin.

## Why it needs a separate boundary

Context Mode can reduce prompt growth by keeping large tool results in a local index
and returning selected context. That is valuable for long-running roles, but its MCP
server also exposes command execution, file indexing, network fetch, maintenance, and
data-deletion operations. Its process sandbox is a separate subprocess, not an
operating-system security boundary, and is intentionally able to inherit common CLI
credentials.

Exposing those tools directly would create paths around the current guarantees:

- Orchestrator and Scout have no shell.
- Reviewer shell commands are restricted to a read-only/test allowlist.
- Builder shell commands have destructive, privilege, publishing, and Git-history
  denylists.
- every role is constrained to its assigned repository or snapshot root;
- agents cannot update dependencies, fetch arbitrary network content, purge runtime
  data, or open external dashboards on their own.

The existing `role-guard` only understands the current Pi tools. A `ctx_*` call must
therefore be denied until it has an equivalent policy path of its own.

## Required architecture

1. **Package-local, pinned dependency.** Install one exact reviewed Context Mode
   version as a repository dependency. Never require a global `npm install`, never
   execute `ctx_upgrade`, and commit the lockfile.
2. **No global Pi mutation.** Do not write `~/.pi/agent/mcp.json`. Each role must start
   a package-local MCP server through an absolute path and a session-scoped Pi/MCP
   configuration. If the installed Pi release cannot isolate MCP registration per
   role, implementation is a no-go.
3. **One server and data directory per role/run.** Set `CONTEXT_MODE_DIR` to an XDG
   state path derived from the workflow run and role, for example
   `.../pi-herdr-orchestrator/runs/<run>/context-mode/<role>`. Never share databases
   between roles, projects, runs, or normal Pi sessions.
4. **Dedicated Context Mode guard.** Register only explicitly approved tools for the
   active role. Validate paths after realpath resolution, reject symlink escapes, and
   apply the same command policy as native Bash before forwarding a request.
5. **Deterministic enforcement.** Tests must prove that policy validation happens
   before Context Mode executes or indexes anything. If Pi extension/MCP hook ordering
   cannot guarantee this, implementation is a no-go.
6. **Native-tool fallback.** A missing or crashed Context Mode server falls back to
   the role's existing safe tools. It must never weaken a policy or block workflow
   recovery.
7. **Nested subagents excluded.** Packaged subagents keep their current four
   read/search tools and receive no Context Mode extension, skill, MCP server, or
   inherited database.

## Proposed tool policy

`Candidate` means still denied until the listed rollout phase and all acceptance
gates pass. `Operator` means an explicit human/controller operation, never an agent
tool.

| Tool | Orchestrator | Scout | Builder | Reviewer | Nested | Required constraint |
| --- | --- | --- | --- | --- | --- | --- |
| `ctx_search` | Candidate | Candidate | Candidate | Candidate | Deny | Own role/run index only; bounded result size |
| `ctx_stats` | Candidate | Candidate | Candidate | Candidate | Deny | Own store only; no paths or content from other stores |
| `ctx_index` | Candidate | Candidate | Candidate | Candidate | Deny | Inputs below role root; secret filters; no symlink escape |
| `ctx_doctor` | Operator | Deny | Deny | Deny | Deny | Redacted diagnostics through the controller |
| `ctx_execute` | Deny | Deny | Phase 3 candidate | Phase 3 candidate | Deny | OS sandbox, stripped credentials, role command policy |
| `ctx_execute_file` | Deny | Deny | Deny | Deny | Deny | Executing repository files is outside the initial design |
| `ctx_batch_execute` | Deny | Deny | Deny | Deny | Deny | Multi-command and partial-failure semantics are too broad |
| `ctx_fetch_and_index` | Deny | Deny | Deny | Deny | Deny | No agent-controlled network access |
| `ctx_upgrade` | Deny | Deny | Deny | Deny | Deny | Updates only through a reviewed dependency change |
| `ctx_purge` | Operator | Deny | Deny | Deny | Deny | Exact run/role target plus explicit approval |
| `ctx_insight` | Operator | Deny | Deny | Deny | Deny | No automatic browser/dashboard launch or data exposure |

### Command execution gate

Execution tools are not part of the first implementation. A later proposal may
enable only `ctx_execute` for Builder and Reviewer if all of these are true:

- the subprocess runs in a container, VM, micro-VM, or enforceable OS sandbox;
- its only writable mount is Builder's assigned root; Reviewer receives a read-only
  snapshot except for isolated test caches;
- provider keys, SSH agents, cloud credentials, Docker sockets, Kubernetes config,
  package-publish tokens, and unrelated environment variables are removed;
- command parsing and policy are at least as strict as native role Bash;
- time, process, output, disk, and network limits are enforced outside the model;
- the full command and policy decision are recorded without recording secrets.

Without every item, native Bash remains the only command path.

## Data and secret controls

- Resolve and verify every input path against `PI_HERDR_ORCHESTRATOR_ROLE_ROOT`.
- Exclude `.git`, runtime state, unrelated worktrees, dependency trees, binaries, and
  files matching secret/credential patterns such as `.env*`, auth files, private
  keys, cloud credentials, and token stores.
- Treat `.gitignore` as an additional exclusion, not the security policy: explicit
  deny rules still apply to tracked secrets and unusually named credentials.
- Scan candidate text for high-confidence secret formats before indexing. Reject the
  source rather than attempting lossy redaction inside the database.
- Create directories with `0700` and files with `0600`, subject to platform support.
- Store a repository-root hash, commit/snapshot fingerprint, role, run ID, package
  version, and schema version with every index. Reject stale or mismatched stores.
- Builder edits invalidate affected indexed sources. Reviewer refresh invalidates
  the previous snapshot before any search.
- Never upload indexes, enable telemetry, or open an external viewer automatically.
- Cleanup is explicit and recoverable where practical. Finishing a workflow reports
  retained stores; it does not silently purge them.

## Lifecycle and compaction

Context Mode hooks can observe tool calls/results and session compaction. The wrapper
must be inactive until the role lease and guard are established, and must unregister
before that lease is restored or the role closes. Compaction summaries remain role
local and include provenance for fetched excerpts. An index is never authoritative
source code: agents re-read current files before editing or approving.

Concurrent roles get separate servers and directories. Startup is idempotent, and a
stale server from a previous run cannot be adopted merely because repository paths
match.

## Rollout

0. **Baseline:** measure prompt/tool-result growth, compaction frequency, latency,
   answer quality, and task success on representative long workflows.
1. **Read-only pilot:** opt-in Scout and Reviewer to `ctx_index`, `ctx_search`, and
   `ctx_stats` only. No lifecycle interception of unrelated tools unless separately
   verified.
2. **Primary-role pilot:** extend the same read-only surface to Builder and then
   Orchestrator after stale-index and concurrent-edit tests pass.
3. **Execution experiment:** consider `ctx_execute` for Builder/Reviewer only in an
   external OS sandbox and after a fresh security review. This is optional.
4. **General availability:** remain opt-in per workflow until operational evidence
   justifies a default change. Nested subagents remain excluded.

Every phase needs a kill switch that restores native-tool behavior without changing
role prompts or repository state.

## Verification matrix

A future implementation must include automated tests for:

- exact dependency/lockfile version and no global Pi configuration writes;
- tool registration for every role, normal Pi, and nested subagent;
- traversal, absolute paths, symlink escape, case variants, and TOCTOU replacement;
- `.env`, private key, token, tracked-secret, `.git`, binary, and ignored-file denial;
- Builder denied commands and every Reviewer allowed/disallowed command through
  `ctx_execute`, including quoting, pipes, scripts, and indirect executables;
- stripped environment, sockets, home/config mounts, DNS, and outbound network;
- concurrent runs, role isolation, stale HEAD, Builder edits, and Reviewer refresh;
- large/binary output, timeout, cancellation, partial failure, crash, corrupt index,
  disk exhaustion, and server restart;
- compaction before/after guard activation and restoration;
- maintenance, network, dashboard, execute-file, and batch tools staying unavailable;
- fallback to native tools with no policy or task-result regression.

## Acceptance criteria

Context Mode remains disabled unless the pilot demonstrates all of the following:

- zero role-policy regressions in the verification matrix;
- no secret or cross-role content in another role's prompt, index, logs, or results;
- no writes to global Pi/Context Mode configuration;
- deterministic cleanup and recovery from a missing or crashed MCP server;
- a meaningful measured context reduction (target: at least 30% fewer tool-result
  tokens on the selected long-task corpus) without lower task or review quality;
- acceptable startup, indexing, search, and disk overhead;
- completed review of the Elastic-2.0 license for the intended distribution model.

## Upstream references

- [Context Mode package documentation](https://pi.dev/packages/context-mode)
- [Context Mode source repository](https://github.com/mksglu/context-mode)
