# apps/cli/src/commands

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Command entrypoints, the daemon runner, and session dispatch from the CLI/MCP boundary.
[apps/cli/AGENTS.md](../../AGENTS.md) applies; session-side rules are in
[../session/AGENTS.md](../session/AGENTS.md).

## Process and daemon lifecycle

- New one-shot commands should use `../lib/command-runtime.ts` (`runOneShotCommand`) so exit
  codes, telemetry flush, and stream flushing stay consistent.
- Process entrypoints, command-owned boundaries, global process-error handlers, and generated
  standalone shims may force exit after their own cleanup policy: `start.ts` owns startup, fatal,
  and signal exits; `daemon-runner.ts` owns watchdog fatal and signal exits. Never force exit from
  reusable libraries, session/agent internals, TUI/watch flows, or worker code — expose cleanup
  and let the process boundary decide.
- Remote daemon restart/upgrade (context/machine-lifecycle.md): the RPC handler ACKs and asks
  `start.ts` to exit with the reserved lifecycle code; the watchdog does upgrade/restart work
  after the worker exits.
- `lody daemon start` resolves cloud authentication in the FOREGROUND process before spawning the
  detached runner (`daemon-auth-preflight.ts`): validate the cached credential, and on a
  missing/rejected one run the interactive device-authorization flow there. An unreachable backend
  aborts instead of re-authenticating, and a non-TTY run aborts instead of blocking on a browser
  link. `--skip-auth-check` is the opt-out; `--auth` keeps its non-interactive path.
- The runner's fd 3 launch handshake reports success only after its supervised Worker reaches
  `startupStage=ready`. An initial Worker exit returns bounded output and terminates the runner
  instead of claiming success; retryable startup exits keep the handshake pending, and a timeout
  terminates and awaits the exact spawned runner before reporting failure.
- Cloud-mode `lody daemon status` reads the runtime probe's explicit `backend`
  authorization/connection state and `connectedWorkspaces`; local mode omits that cloud-only
  block. Aggregate `connectivity` is local runtime health and must not be presented as proof that
  the cached CLI token was accepted.
- Connection-age fields preserve one continuous non-connected interval across
  connecting/disconnected transitions and clear only on connected. Keep them in the top-level
  `connectionAges` v1 extension: older consumers reject unknown keys inside the strict
  backend/workspace objects. Status reports a red connection error at 60 seconds.

## Read commands and workspace sync

- Session read commands (`session list/show/history/status`, `export`) sync Loro metadata/docs
  before reading by default; sync failure is a command failure with an `--offline` hint.
  `--offline` is the explicit local-cache path, never an automatic fallback. `lody sync` is the
  explicit workspace sync command and excludes Code Collab file-index Flock docs.
- Persisting a non-empty Task document makes loro-repo register `e/task-<id>` in workspace meta;
  Task fields are not copied into `m/task-<id>/*`. `listWorkspaceTaskIds` combines that physical
  source (`listAliveRoomIds` over `e/*`) with visible Task Index rows, repairs a missing row from
  its document, and honors an explicit tombstone. `sync`, `export`, and account deletion must
  retain BOTH discovery paths so an interrupted or legacy write cannot escape coverage.

## `lody app`

- `app.ts` registers the directory as a local project through the daemon (`local-project/add`,
  idempotent — the id is a sha256 of the resolved root path), then opens the active installation
  profile's deep link (`lody://chat/new?…` cloud, `lody-oss://chat/new?…` local). Link shape lives
  in `../lib/desktop-deep-link.ts` and both sides pin the URL in unit tests.
- INVARIANT: registration happens only in the CLI. The deep link carries ids, never a path, and
  the app must never register a project from one — any web page can navigate the OS to either
  registered protocol, so a path-carrying link would let a site hand agents an arbitrary
  directory. An unknown project id just stays unselected.
- `workspaceSlug` is present only when the daemon reported workspace candidates.
- Daemon down is not a failure: the deterministic project id is computed locally and the app still
  opens, with a warning that a brand-new directory was not registered.
- Local-project control transport and the workspace picker are shared with `lody project`
  (`../lib/local-project-control-client.ts`).

## `lody review` (no-login HTML review)

- `review.ts` involves no Lody login: it resolves `.review.md` against the local Git repo
  read-only, and a render failure prints `error.message` with `process.exitCode = 1`.
- The ~8 MB viewer is NOT bundled. `../lib/review-viewer.ts` fetches `standalone.html` at the EXACT
  version the CLI was built against, verifies its sha256, and caches it under
  `~/.lody/code-review-viewer/`. `LODY_REVIEW_VIEWER` overrides the source for offline/mirror use
  and stays sha-verified. The pinned version and sha come from the bundled-at-build
  `lody-code-review-viewer/manifest` import, and the release pipeline must publish the viewer at
  the same version before the CLI. Keep the agent prompt embedded and lazy-imported.

## Session create and dispatch (`session.ts`)

- `--local-project … --worktree` sets `ProjectRef.useWorktree`; daemon startup consumes it in
  `../session/session-execution-service.ts` and worktree creation happens in
  `../session/session-manager.ts`.
- Local create resolves `ProjectRef.githubRepoFullName` from the project's `origin` for direct AND
  worktree sessions, exactly like desktop creation, because `repoFullName`, PR actions, and
  post-turn PR detection all read it. Bind only a repository the workspace enables, recording the
  workspace's spelling; an unauthorized, absent, or unreadable one leaves the Session local rather
  than failing create.
- Dispatch point-of-no-rollback (`createSessionResult` / `sendSessionChatResult`):
  `writeDispatchPointer` commits `latestUserMsgId` locally, after which the daemon may already be
  executing the turn. `confirmDispatchSyncedBestEffort` is AWAITED so the push completes before
  the one-shot `withWorkspaceManager` transport is torn down, but it must NEVER throw — the
  durable pointer plus the SQLite Operation own delivery. The create/chat `catch` may only unwind
  when the pointer was NOT yet written (`if (!dispatched)`); rolling back after dispatch deletes an
  already-running session out from under the daemon. Do not reintroduce a hard-fail Streams ack on
  the dispatch write.
- MCP create takes run config semantically (`modelId`/`reasoningEffort`/`fastMode`/`planMode`),
  never raw ACP option ids. `@lody/shared` `acp-run-config.ts` owns the mapping onto each agent's
  advertised option ids, `applyAgentRunConfigSelection` applies it once the target agent's cached
  capabilities are read, and `validateSessionCreateOptions({ dispatchConfig })` rejects
  unsupported selections before the Operation is accepted. Durable create acceptance stores each
  target's resolved effective dispatch config; recovery must use it instead of inheriting again
  from mutable requester history.
- Local daemon IPC sends the real control request once; do not restore a health preflight. Native
  `LocalDaemonAvailabilityError` must be thrown outside the Effect runtime boundary so MCP can
  preserve `DAEMON_NOT_RUNNING` versus retryable `DAEMON_BUSY`: a connection refusal means not
  running, timeout/408/429/5xx means busy.
- A renderer joining a local data-plane Session Doc room must not call
  `LoroDocumentManager.getOrCreateSessionDoc` or retain a live cloud room; use the bounded raw-doc
  one-shot reconciliation in `../lib/loro/doc.ts`, cancel it on local leave or Session activation,
  and unload renderer-only docs after the last peer leaves. Session metadata/RPC activation owns
  persistent CLI cloud joins; Flock room bridging stays paired to local Flock join/leave.
