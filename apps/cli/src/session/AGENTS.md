# apps/cli/src/session — Index

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

**Dispatch architecture: context/message-flow.md**
— user turns arrive by being written into the session doc (meta pointers), not via a
message bus. The WS/DO path is DEPRECATED.

Session CLI/MCP orchestration contract:
specs/session-orchestration.md. Target-machine
authorization is checked by the injected access capability with the source CLI token,
which derives the requester identity at the trusted boundary. Do not send a caller-supplied requester
through workspace Machine RPC: that transport does not authenticate member identity.
Live status is a target-daemon Machine RPC read, and durable session metadata is not a
live-presence substitute.
Session orchestration MCP intentionally runs with the daemon owner's CLI credential,
including for teammate-started Sessions on a shared machine. Do not add requester
delegation proofs or a shared-machine gate without a new product and security decision.

- `session-dispatch-watcher.ts` — the current dispatch entry: watches
  `repo.watch('doc-metadata')` + per-session mirror subscribe; dispatches when
  `latestUserMsgId` ≠ `lastHandledUserMsgId`. Also accepts `session/dispatch-turn`
  Machine RPC pushes via `offerRpcTurn` (ack-then-execute: stash the payload as a
  third turn source — history → queue → stash — and wake the per-session check
  chain; the RPC ack means delivered, not authorized/executed). Fast-path turns
  that finish before their history entry syncs are reconciled by
  `maybeRepairAlreadyHandledTurn` (late `pending` entry gets flipped to its
  recorded terminal status, never re-dispatched). Extensive header comment is the
  authoritative doc for edge cases (stale pointers, history/meta sync races).
  Turn-resolution waits must subscribe to RPC offers before awaiting Doc Room
  join/sync; the offer wakes the existing serialized resolver and must never
  dispatch directly from the RPC handler. History synchronization continues as
  the durable fallback and output-ordering gate, not as a fast-path prerequisite.
  Missing-history delivery recovery must never advance `lastHandledUserMsgId`;
  clear `latestUserMsgId`/`processingUserMsgId`, set `lastMissingHistoryUserMsgId`,
  and surface a `chat_failed` notice instead. The watcher must not publish or clear
  session active presence; `../lib/loro/session-active-presence.ts` is the only owner
  for start/phase/heartbeat/clear. Owned-session startup/meta bootstrap scans may contain
  thousands of rooms; reconcile them with the fixed four-room concurrency bound rather
  than materializing an unbounded `Promise.all`. That scan is idempotent and costs
  seconds of main-thread work, so `enqueueBootstrap` folds concurrent requests into a
  single queued drain (`pendingBootstrapReasons` + `bootstrapChain`) — none are dropped.
  Do not restore a per-trigger scan: `onMetaRoomSynced` fires on Streams recovery, so a
  misread transport edge turns into an O(rooms) scan every few seconds. Coalescing bounds
  the work per trigger, not the trigger rate — keeping that rate sane is the connection
  recovery boundary's job, and it now does: `onMetaRoomSynced` is rate-limited in
  `../lib/loro/connection-recovery.ts`, while the cheap "back online" edge moved to
  `onStreamsOnline`. Do not add a competing throttle here — that would move the cost
  model and hide the one that matters
  (context/code-collab-flow.md).
- `turn-history-gate.ts` — ordering barrier for RPC fast-path turns: the agent
  starts immediately, but turn-scoped history LIST writes (assistant entry, ACP
  flushes, finalization, failure notices) wait until the user turn entry has
  synced into the CLI-local doc (bounded, 20s), otherwise concurrent Loro list
  inserts can permanently order the reply before the user message. The gate
  itself creates the assistant entry when it opens; created in message-handler's
  `beginConversationTurn`, stored/disposed via `SessionTransientStore` turn state.
  Status/meta map writes are never gated (some sit on the prompt critical path).
- `session-dispatch-logic.ts` — pure decision functions for the watcher (testable).
- `session-execution-service.ts` — runs one turn end-to-end: ACP prompt, turn ids,
  lifecycle/error handling, GitHub/local project setup, and post-turn diffStats.
  Goal lifecycle is independent from prompt lifecycle: an `active` session goal does
  not suppress turn completion or completion notification once the current prompt is
  quiescent. Use live execution/presence for current-work signals; goal activity may
  still protect history rewrites or an in-memory runtime that can resume autonomously.
  It is the per-session execution mutex: never mint a second visible turn while a
  `TurnRuntimeState` is registered. User-dispatch turns derive assistant entry ids
  from `userTurnId` (`assistant:<userTurnId>`), so a retried/recovered dispatch reuses
  the same history entry.
  INVARIANT: a steer (guide) the agent never accepted must not stay parked in
  `pending_apply` — dispatch skips that status, so nothing else would ever run it.
  `requeueUndeliveredSteer` hands it back to ordinary dispatch, and the load-bearing
  write is the `latestUserMsgId` POINTER, not the entry status: `sessionNeedsActiveWatch`
  reads meta only, so a turn visible solely in history is dropped the moment the
  session goes idle (the watcher unsubscribes) and never reconsidered, restart
  included. That is also why `findNextDispatchableUserTurn` dispatches a
  `pending_apply` entry the pointer explicitly names — the flip to `pending` is a UI
  and durability nicety that a not-yet-synced entry never receives. Only
  pre-submission rejections plus the agent's own `AgentSteerNotDeliveredError` refusal
  qualify: after submission the provider may already have committed the steer, and
  re-sending would duplicate it. An entry that is already active, terminal, or past
  `lastHandledUserMsgId` is left alone so a late duplicate cannot resurrect a turn.
  Because teardown/cancel finalize (`message-handler.ts`
  `finalizeACPState`, no-turnId overload) stamps `finished=true`/`endedAt` on the
  in-progress entry, resume must **reopen** it: `writeAssistantEntryForTurn`'s
  existing-entry branch clears `finished`/`endedAt`/`permissionWaitMs` when re-adopting
  the entry for a live turn. Without that reset a machine-death-then-resume turn streams
  new output into a `finished=true` entry — the web renderer folds the still-streaming
  turn into a `Worked for …` summary and shared "active assistant entry" logic
  (`@lody/shared` `schema.ts` terminal predicate) treats it as done. Keep the reset
  scoped to this reopen branch (it only runs at genuine turn (re)start via
  `openAssistantEntry`); never write `finished=false` from the teardown paths. Renderer
  side: packages/components/src/components/ai-gui/AGENTS.md ("Worked for …" collapse gate).
  ACP error classification lives in `acp-error-classification.ts`; keep new
  JSON-RPC/transport string matching there instead of scattering it through the
  execution service. A `-32603 Internal error` whose details say the connection
  is disposed/stale is an `agent_disconnected` case, not a generic
  `acp_internal_error`. Continue-session prompt recovery may terminate and restore
  the ACP session once before retrying the same prompt, but only when no ACP output
  has buffered/flushed for that assistant turn; after visible output, never replay
  the user prompt automatically.
  Code Collab v1 turn markers and history fileDiff capture were removed. v2 may
  persist exact per-turn path/add/del caches derived from the CLI-local ACP evidence
  store after ACP finalization; diff content still comes only from the CLI store.
  The post-turn shared-state refresh remains best effort after a turn/cancel/error.
  Shortcut for PR/sidebar line-count parity: GitHub session `diffStats` are written by
  `turn-post-processing-service.updateSessionDiffStats()` from
  `../lib/git/git-diff-stats.ts`. It must use PR compare semantics
  (`merge-base(PR base, HEAD)` → `HEAD`) rather than dirty working-tree totals.
  Code Collab All Changes may write the compact owner-room `diffStats` summary for
  confirmed local sessions and GitHub sessions without an open PR
  (`session-diff-stats-target.ts`). GitHub sessions with an open PR keep the
  committed PR-compare writer above; unresolved project state and incomplete
  All Changes line stats must skip instead of overwriting a trustworthy total.
- `session-manager.ts` / `session.ts` — session/process lifecycle, workdirs and
  worktrees. Child tab sessions must reuse the parent workspace directory: local/GitHub
  parents reconstruct via workdir/worktree data, and chat-only parents fall back to the
  parent's default `~/.lody/chats/<parentSessionId>` path when the parent process is no
  longer in memory. Do not write per-session workspace paths into `MachineMeta`; the
  machine publishes `['dotlodyPath']` in its machine Flock doc and frontends derive
  `~/.lody/chats/<sessionId>` or `~/.lody/repos/<repoId>/worktrees/<sessionId>`.
  Worktree setup scripts are per worktree-directory lifetime: session runtime restore
  after idle GC must skip setup when the session's worktree directory already exists,
  but setup still runs when a missing worktree directory is materialized again.
  INVARIANT: any `sandbox.spawn` whose OUTPUT is the result must pass
  `captureOutput: true` (`session-sandbox.ts`). spawn() does async post-spawn work
  (pid wait, resource profile, cgroup attach), and under a stalled event loop a short
  command exits and its stdio is destroyed — dropping buffered output — before the
  caller subscribes; `exec()` then resolves `''` and also ignores the exit code, so a
  failed command is indistinguishable from an empty one. This is why a session that
  had just opened a PR reported "detached HEAD" and never associated it. Long-lived
  ACP stdio deliberately does NOT capture (it streams and would grow unbounded).
  The capture buffer is capped (4 MiB, oldest chunks evicted) because consumers
  apply their own limits only after they subscribe.
  Shutdown is two-phase: `cleanUp({ keepWorkspaceDocumentOpen: true })` terminates all
  session/preparation producers but deliberately leaves the document manager and credentials
  alive so MessageHandler can flush final ACP/Code Collab evidence; the later plain `cleanUp()`
  closes shared resources. Never restore document teardown ahead of session termination.
- `session-preparation-service.ts` — process-local speculative ACP lease/state owner.
  Peek/claim are synchronous published-resource snapshots and must never delay cold
  fallback; peek never transfers ownership. A prepared resource may reuse its open
  target-machine Flock to synchronously resolve launch config, but dispatch and claim
  must rescan the current row and reject changed compatibility. Publish the resource
  before its `start()` hook: worktree/ACP side effects must never begin while the
  resource is invisible to synchronous claim. Preparation may create the final marked
  worktree and complete `newSession`, but must not create a session doc, run worktree
  setup, append history, or publish session events before adoption. Durable creation
  claims the marker only when repo/source/base-branch target identity matches, runs
  setup, then permits the first prompt. An unpublished incompatible preparation must
  never delay cold fallback; a published incompatible resource must finish cleanup
  before cold worktree materialization so two owners cannot race the same path. Full
  lifecycle, sandbox/worktree ownership, crash recovery, TTL, and transport map:
  The detailed contract remains in the private architecture context.
  Launch compatibility must use canonical `buildSessionLaunchConfig` semantics: empty
  env/runtime override values omitted by durable dispatch are equivalent to empty values
  read directly from the agent config during preparation.
- Nested child Sessions are intentionally rejected: workspace ownership currently resolves
  one parent hop only. Do not enable deeper trees without a durable root workspace owner.
- `session-fork-service.ts` owns the fork saga. Its commit boundary is
  `LoroDocumentManager.persistPendingChanges()`, which flushes target meta/history to the owning
  CLI's local SQLite repo before returning success. Cloud `waitUntilSynced()` is never a fork
  success condition: local-machine forks must work offline, while RemoteBridge owns later cloud
  convergence. Persist the target placeholder before invoking ACP; if the final local commit
  fails, terminate the forked ACP session and durably delete the target. An active source turn may
  be forked only when its live ACP connection advertises
  `_meta.lody.forkAtTurn = { version: 1 }`. Persist the adapter-emitted
  `_meta.lody.turnId` on the matching assistant history entry as `acpTurnId`, then return it
  unchanged as `session/fork.params._meta.lody.forkAtTurn.turnId`. Codex emits its native turn id
  and Claude emits its SDK assistant uuid; never infer a boundary from Lody ids or copy the
  unfinished user/assistant suffix. Fork user resolution optimistically reuses the live source
  Session's effective Git identity only when its recorded requester user id exactly matches the
  fork requester; an absent source runtime or mismatch must fall back to `SessionUserResolver`.
  `SessionForkSpec.targetPlacement === 'side-panel'` is a sparse
  presentation hint persisted as target `childSessionPlacement`; it does not alter parent/root
  workspace ownership, history cloning, ACP lifetime, or the fork commit boundary.
- `session-edit-and-resend-service.ts` owns same-Lody-session replacement of the last normal User
  turn for builtin Codex/Claude. Prepare provider `forkAtTurn` (or `session/new` for the first
  User) before cancelling the exact active turn, then wait for old ownership release before one
  durable history-tail/meta commit. Its rewrite barrier is mutually exclusive with message-queue
  promotion and blocks dispatch/steer; the queue itself is never rewritten. Preserve the original
  User attribution/config/attachments unless the edit explicitly changes them, use new logical
  turn ids and ACP session identity, and never replay transcript or roll back filesystem changes.
- `session-launch-config-resolver.ts` / `worktree/worktree-config-resolver.ts` — durable
  launch config rule: do not write per-session `sessionLaunchConfig`; first
  `session/create` payload is transient, resume/dispatch resolve from agent config/project,
  and the legacy row is fallback/cleanup only.
- Resuming a Session on a local project must use the workspace's current branch as-is, including
  worktree mode. Branch selection may resolve and check out a branch during the initial
  `session/create`, but an ACP restore must never prepare or switch back to the Session's recorded
  branch.
- `turn-post-processing-service.ts` — post-turn work (titles, notifications).
- `session-access-policy.ts` — local-first dispatch access precheck (optimistic-allow
  cache, D11). It may allow owner-cached turns from the catalog snapshot, deny
  `remote_missing` workspaces, or return `remote` to preserve the existing Convex
  three-state path. Catalog read failures degrade to `remote` (never error).
- `session-access-retry.ts` — remote machine access verification with transient retry.
- `session-user-resolver.ts` + `git-identity.ts` — the requesting user's commit
  identity. The turn's `userName`/`userEmail` become `GIT_AUTHOR_*`/`GIT_COMMITTER_*`
  in the session env (`session.ts` `updateGitIdentity`, re-applied per turn via the
  execution service's `bindReadySession`), so a session started by user A commits as
  A. Resolution MUST go through the injected
  `CloudPort.access.resolveWorkspaceUser`; the cloud composition root owns the
  hosted user-resolution operation because the daemon does not own an end-user
  browser session. The local
  access port resolves only its synthetic owner and never performs network I/O.
  `resolveSessionGitIdentity` then falls back to the daemon host's git config — i.e.
  the machine owner. A missing-email placeholder is not a commit identity; prefer the
  cached GitHub `id+login@users.noreply.github.com` address so the commit is
  attributed to the same GitHub account that opens the PR (PR/push identity itself
  comes from the requester-bound GitHub token, not from git config). Every new
  dispatch/delivery path that mints `userName`/`userEmail` must resolve them; a
  placeholder there silently reassigns authorship to the host.

Dispatch access is local-policy first, optional-cloud three-state second. Owner-cached local
policy may allow without network access; `remote_missing` workspaces fail the turn. Otherwise
the remote check is still three-state: definitive `denied` fails the turn;
`indeterminate` means the backend call did not reach a verdict, so the watcher leaves
the turn pending and forks `verifyMachineAccessWithRetry()` with capped backoff.
Do not collapse thrown access checks into denial. Every owner-allowed dispatch also
fires `fireOwnerAccessRecheck` (fire-and-forget, `forceBackendVerification: true`,
bypassing the message-handler owner fast-path): a confirmed online allow is the ONLY
writer of the access snapshot/`verifiedAt`, a definitive deny clears it, and
`indeterminate` writes nothing.
