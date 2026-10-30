# apps/cli/src/lib — file responsibilities

Binding rules live in [AGENTS.md](AGENTS.md) and in the scoped `AGENTS.md` of each
subdirectory; this file is the navigation index. Cross-module explanations live in
[`.agents/docs/`](../../../../.agents/docs/AGENTS.md).

## Local persistence

- `local-workspace-catalog.ts` — cached workspace/identity discovery; mutations
  compose native FileLocks and keep the file write inside its lease. Read-cache
  refresh orchestration remains Promise-based. Existing application entrypoints
  provide the lock through the shared `fileLocksLegacy` runtime until daemon
  composition migrates. Encrypted discovery uses a separate account/machine-bound sidecar.
  Only authenticated online-list reconciliation can archive a corrupt sidecar and
  rebuild it behind the invalid marker; offline and ordinary operations retain the error.
  [Recovery decision](../../../../.agents/notes/implemented/bug-fix/2026-10-27-e2ee-catalog-recovery.md).

## Resource discovery

- `workspace-command-manager.ts` — overlapping standalone commands borrow one
  document manager through `command-runtime.ts`; the last callback awaits its
  cleanup. Authorization scopes stay separate; a failed cleanup is reported once
  and never blocks later commands. Daemon-executed commands borrow the daemon's
  replica through `session-command-environment.ts` instead.
- `discovery-query.ts` — strict query schemas, scope-bound keyset pagination and
  shared Session title/Machine/Agent/Role filters.
- `resource-discovery.ts` — readable directory projections, Role availability,
  sensitive-field exclusion and list/get behavior shared by MCP and CLI.
  List inputs are validated here against resource-specific allowlists derived from
  the shared query schema; the CLI only translates flags and resolves selectors.
- `resource-discovery-runtime.ts` — workspace readers and caller-specific authorization.
  Daemon reads wait briefly for the first baseline, then return cached results with
  `catalog_syncing` uncertainty until confirmed; later reads never force catch-up.
  `loro/workspace-catalog-sync.ts` holds metadata, workspace and authorized Machine
  readers on the existing Promise Repo using its public room and replica leases.
  Failed baseline barriers retry with capped backoff on the same binding, so a
  temporary storage error can recover without replacing the reader or reconnecting.
  `workspace-catalog-sync-legacy.ts` owns the manager-facing Scope and closes it
  before Repo shutdown; transport recovery keeps live rooms current.
  Role create/update proposals require confirmed metadata/workspace synchronization;
  creation also confirms the authorized target catalog before publishing a card.
  Standalone CLI calls synchronize unless `--offline`. Authorization and cloud presence
  remain online-aware independently of the catalog read policy.
  Intent and limits: [resource discovery](../../../../specs/resource-discovery.md).
- `workspace-mcp-store.ts` — workspace MCP persistence, default selection reads and
  the shared first-baseline wait. Daemon-hosted default resolution waits up to one
  second for that reader. Reader ownership is detected on the manager, including
  Schedule validation outside Session ALS. If still cold, a persisted remote checkpoint for the same
  workspace Flock permits empty or nonempty cached defaults; locally authored rows
  alone do not establish remote history. No evidence returns retryable
  `SYNC_UNAVAILABLE` before Operation acceptance. These are authoring preferences,
  not authorization verdicts; accepted Operations freeze their selected IDs.
  Startup separately waits briefly for the shared baseline, then may use
  complete selected rows locally with a config warning. Missing selected rows retain
  the typed cold error for one recheck at provider-session establishment; continued
  uncertainty rejects initialization rather than silently omitting selected tools.
  Request timeout never cancels the reader. Explicit selections bypass default
  resolution, and standalone CLI synchronization retains its existing behavior.
- `agent-role-create.ts` — Agent Role catalog read and create-path resolution
  shared by the MCP create tools and CLI `session create --agent-role`: the Role
  row is authoritative for machine, agent config, run config and prompt prefix,
  and the create freezes Role id/revision/snapshot as provenance.

## Message hub and transports

`message-processor.ts` separates health reads, cancellation, per-provider refreshes
and per-agent installs from slow probes; restart/upgrade share one lifecycle lane.
Unlisted requests retain their existing ordering. [Local control lane decision](../../../../.agents/notes/implemented/bug-fix/2026-09-20-acp-authenticate-queue-lane.md).

- `github-git-transport.ts` — generated Git wrapper and HTTP credential adapters.
  HTTP helper redispatch preserves the parent operation's read/write context;
  independent commands classify themselves, and missing/invalid helper context
  conservatively requires write access. Credential probes precede the single
  native transfer. The one-time `git --exec-path` probe result is recorded in a
  `lody-git-transport.json` marker: matching markers skip the probe, transient
  spawn errors retry with bounded backoff, and a probe that still fails reuses
  any usable recorded layout rather than blocking session startup.

- `gh-pr-create-script.ts` — REST creation for managed `gh pr create/new` with
  explicit title and body/body-file; retains the selected credential for metadata.
  Infers a current head only when its SHA is already published in the target repo,
  and base from `branch.<current>.gh-merge-base` or the repository default.
  Fill, interactive, attachment and push/fork modes retain native gh with an App
  attribution warning. Creation outcomes are never replayed; print the created
  URL before optional metadata can fail. See the [decision](../../../../.agents/notes/implemented/bug-fix/2026-10-11-github-pr-app-attribution.md).

- `usage/usage-tracking-service.ts` — cumulative usage snapshot staging and
  acknowledgement-based retry retention; deltas are never added again.
  Scope and limits: [usage delivery](../../../../specs/usage-delivery.md).

- `message-handler.ts` — the CLI's central message hub (largest file): session chat
  handling (`handleSessionChat`), ACP update buffering/flush, Code Collab v2 machine
  RPC wiring, local project control, session file upload/send, and the turn cloud
  side-effect gate. Turn execution itself lives in
  `../session/session-execution-service.ts`.
  Machine registration passes the daemon's `TZ` hint to `getDeviceTimeZone`:
  when Intl exposes no zone name, named zoneinfo paths and fixed whole-hour
  POSIX zones such as `HKT-8` are resolved before the legacy UTC fallback.
  See the [timezone decision](../../../../.agents/notes/implemented/bug-fix/2026-10-18-linux-schedule-timezone.md).
- `machine-runtime.ts` — machine runtime bootstrap; still hosts the DEPRECATED hosted
  WS control-plane listener, and serializes remote bridge attach/detach/revoke through
  `runBridgeTransition`.
- `machine-lifecycle.ts` — remote lifecycle verification and upgrade intents; runs the
  fixed npm install through the shared process layer’s `startProcessLegacy` so Windows `npm.cmd` shims use the command
  interpreter. It resolves the installed package through that npm's global root
  and verifies its entry/version. `../commands/daemon-runner.ts` owns restart and
  handoff to that explicit entry, including matching-version readiness.
- `cloud-cli-port.ts` — the sole official-build composition root for cloud clients,
  endpoint-derived adapters, and their lifecycle. `start.ts` validates
  identity/deployment configuration once and injects the resulting `CloudPort` through
  Fleet → Lody → MachineRuntime → MessageHandler/Loro/session services. Its native
  Streams token factory requires the caller's Scope; it retains Legacy token
  providers until cloud disposal and reports failed cleanup. Existing durable and
  Machine RPC consumers keep the visible Legacy token port until their owners migrate.
- `cloud-pr-association.ts` — hosted PR association HTTP requests and shared failure
  cooldowns; independent of GitHub observation and publication.
- `local-loro-data-plane-server.ts` — Electron renderer ↔ CLI local Loro data plane
  (protocol v7). The explicitly Legacy room engine consumes the native process-wide
  writer and awaits disconnect release; Node write/drain stays one adapter. Room
  message ordering remains Promise orchestration. Design:
  [`.agents/docs/cli-lib-local-loro-data-plane.md`](../../../../.agents/docs/cli-lib-local-loro-data-plane.md).
- `local-ipc-socket-server.ts`, `local-control-handler.ts`, `local-session-control.ts`,
  `local-project-control-service.ts`, `local-project-control-client.ts` — the local
  daemon socket surface and its clients.

## Sessions, files, and attachments

- `session-image-download.ts` — CLI-side prompt image download through the injected
  attachment capability, including short retries before converting bytes to ACP image
  blocks.
- `session-file-blob-store.ts`, `session-file-attachments.ts`,
  `session-file-backfill.ts`, `acp-agent-attachments.ts` — the attachment lifecycle;
  see
  [`.agents/docs/cli-lib-session-files.md`](../../../../.agents/docs/cli-lib-session-files.md).
- `session-gc-manager.ts` — idle cleanup plus memory-pressure reclamation. Idle also
  asks the native agent (`AgentClient.getNativeWork`, from Core `sessionActivity`)
  whether it still runs or waits on background tasks
  ([decision](../../../../.agents/notes/implemented/bug-fix/2026-10-18-gc-respects-native-agent-work.md)). Per-OS
  measurement rationale:
  [`.agents/docs/cli-lib-memory-pressure.md`](../../../../.agents/docs/cli-lib-memory-pressure.md).
  Completed turns retain their Agent until cleanup. GC goal checks use local storage
  queries without retaining scanned bodies. Process scaling and query measurements:
  [application memory investigation and goal-query decision](../../../../.agents/notes/implemented/architecture/2026-10-30-application-memory-attribution.md).
- `session-transient-store.ts` — buffered ACP updates and their turn ownership;
  each active epoch retains independent event/content facts through flush. The
  image owner drains before content is read and records successful history writes. Classification: [ACP rules](acp/AGENTS.md).
- `session-activity-status.ts`, `session-live-status.ts` — derived busy/idle state.

## Projects and providers

The remote folder picker sends `local-project/create-directory` with a workspace,
absolute parent and one name. `message-handler.ts` and `lody-fleet.ts` check the
target machine/workspace before `LocalProjectControlService.createDirectory`
canonicalizes the parent and uses non-recursive mkdir. Collisions never overwrite
files or links. Creation does not write project metadata; Add still uses prepare-add.
See the [creation decision](../../../../.agents/notes/implemented/feature/2026-10-14-remote-directory-creation.md)
for error handling and the existing UI ownership limitation.

Local-project observation and branch commands use shared `LocalProjects` native
Effect workflows through the visible `localProjectsLegacy` facade while these
entrypoints remain Promise-based. Worktree setup/GC and Session lifecycle still
need their own migration; the facade is removed once the application runtime
provides LocalProjects. See the [decision](../../../../.agents/notes/implemented/architecture/2026-10-10-effect-local-project-git.md).

- `local-project-history-sync-service.ts` / `local-project-history-precheck.ts` —
  Provider-bound local-project ACP history catalogs, import and refresh. Catalogs
  separate configurations; legacy transcript identifiers remain stable.
- `local-project-removal.ts` — local project deletion, session archiving, and optional
  Lody-created worktree cleanup.
- `provider-setup-manager.ts` — durable builtin provider setup; managed runtimes are installed before verification, while user-installed Bub is only published after a successful live probe.

## Subdirectories

- `acp/` — ACP notification → session history pipeline ([AGENTS.md](acp/AGENTS.md)).
- `loro/session-agent-writes.ts` — agent output policy over the shared HistoryWriter;
  mixed tool/subagent batches resolve original ownership and use nested item windows.
  Storage responsibilities: [history writes](../../../../.agents/docs/session-history-writes.md).
- `code-collab/` — unified Code Collab v2 filesystem RPC service
  ([AGENTS.md](code-collab/AGENTS.md)).
- `file-preview/` — the `file/preview` (File Preview v3) read path
  ([AGENTS.md](file-preview/AGENTS.md)).
- `loro/workspace-presence.ts` — native workspace/remote-generation owner;
  `presence-replica.ts` keeps synchronous origin-partitioned CRDT state and
  `presence-legacy.ts` is its application-runtime execution door. Product doc/bridge
  consumers borrow the CLI application registry and one native
  token provider; the platform adapter uses streams-crdt 0.17.0. See the
  [owning scope](../../../../.agents/notes/implemented/architecture/2026-10-12-effect-workspace-presence.md).
- `loro/` — Loro repo/runtime layer, presence, machine flock rooms, and connection
  recovery ([AGENTS.md](loro/AGENTS.md)). `session-model-summary.ts` projects actual
  assistant models through shallow scalar/count reads of already-open documents.
  It compares current catalog metadata on each reconciliation so stale overwrites
  are repaired on the next history change or flush.
  Loro 1.17.0 and LoroRepo 0.24.0 preserve received remote updates that are still
  waiting for causal dependencies through the existing SQLite journal. A durable
  save does not establish complete synchronization or advance another replica's
  cursor. See the [persistence decision](../../../../.agents/notes/implemented/bug-fix/2026-10-22-loro-pending-persistence.md).
  `sqlite-lock-diagnostics.ts` logs, at most once a minute, which processes hold a
  workspace `repo.sqlite3` open when loro-repo or streams-crdt reports
  `database is locked`; it only observes (`lsof`) and never retries or blocks.
  `streams-transport.ts` connects safe failure diagnostics to the existing logger;
  it registers the typed error formatter without adding Repo/WASM imports to the
  generic error utility used by standalone workers.
  The [shared helper](../../../../packages/shared/src/loro-sync-errors/README.md)
  owns the same safe projection used by renderer error details.
- `pr-poller/` — PR discovery, lifecycle, CI rollup, and merge-state reconciliation
  ([AGENTS.md](pr-poller/AGENTS.md)).
- `analytics/`, `git/`, `notifications/`, `session-export/`, `usage/` — supporting
  services.

### Session active presence

`loro/session-active-presence.ts` owns scoped native Turn leases, heartbeat and
initialization-stall signals. `loro/session-active-presence-legacy.ts` is the
MessageHandler construction/analytics entry. Visible Turns acquire the native lease;
other lifecycle callbacks may update phases but cannot release it. Shutdown awaits
those leases before closing documents. See the [presence guide](../../../../.agents/docs/cli-lib-loro-presence.md).
