# apps/cli/src/session

Session lifecycle on the daemon side: watching for user turns, running them through an ACP
agent, and the sagas around them (fork, edit-and-resend, worktrees). Binding
rules live in [AGENTS.md](AGENTS.md) and [worktree/AGENTS.md](worktree/AGENTS.md); this file
is the responsibility index and background.

Dispatch architecture: context/message-flow.md — user turns arrive by being written into the
session doc (meta pointers), not via a message bus. The WS/DO path is DEPRECATED. The
CLI/MCP orchestration contract is specs/session-orchestration.md.

| Boundary         | Owner                                             | Responsibility                                                                       |
| ---------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Admission        | [Dispatch watcher](session-dispatch-watcher.ts)   | Resolves metadata activation against history, queue, and RPC offers.                 |
| Execution        | [Execution service](session-execution-service.ts) | Owns turns, steer results, cancellation, and raw-request drain.                      |
| Process lifetime | [Session](session.ts)                             | Owns ACP resources, confirmed termination, and bounded Codex refresh-start recovery. |

## Files

- `session-dispatch-watcher.ts` — the current dispatch entry: watches
  `repo.watch('doc-metadata')` plus a per-session mirror subscribe and dispatches when
  the shared pending-activation predicate identifies work. Also accepts `session/dispatch-turn`
  Machine RPC pushes via `offerRpcTurn`, which stash the payload as a third turn source
  (history → queue → stash) and wake the per-session check chain. That RPC ack means delivered, not
  authorized or executed. Its extensive header comment
  is the authoritative doc for edge cases (stale pointers, history/meta sync races).
- `session-dispatch-logic.ts` — pure decision functions for the watcher (testable).
- `roost-node-session.ts` — owns Roost history reads/writes and its bounded active-branch
  page cache; `roost-session-backend.ts` joins it to the existing Loro control plane.
- `roost-writer-identity.ts` — persists the replica's signing identity in private
  application data, independent of login credentials and the system credential store.
- `roost-history-generation.ts` — stages structural replacements privately and
  atomically activates them, fencing writes through superseded handles.
- `roost-history-changes.ts` — durable semantic receipts over verified native event intervals;
  owner-scoped checkpoints recover missed logical edits without rereading unchanged bodies.
- `roost-history-diagnostics.ts` — correlates local Worker causes and runtime details
  with the safe error reference returned by history RPC.
- `session-history-owner.ts` — native Effect readiness barrier for history RPC; waits
  for this session's owner/backend metadata and releases its observer on every exit.
- `roost-rpc-session.ts` — Cloud CLI history services backed by owner RPC;
  `lib/command-runtime.ts` supplies the same composition for standalone commands and,
  through `routeRemoteOwnedSessionHistory`, for Sessions the cloud daemon touches on
  other machines.
- `turn-history-gate.ts` — ordering barrier for RPC fast-path turns. Created in
  message-handler's `beginConversationTurn`, stored/disposed via `SessionTransientStore` turn
  state; it creates the assistant entry when it opens.
- `session-execution-service.ts` — runs one turn end-to-end: ACP prompt, turn ids,
  lifecycle/error handling, GitHub/local project setup, and post-turn diffStats.
- `acp-session-config-applier.ts` — resolves top-level and config-option selections,
  then applies mode, model, and dependent options in that order. This prevents model switches
  from resetting an already-applied effort. Reports rejected model selections through the GUI
  warning path, retaining the agent's actual model.
- `session-execution-helpers.ts` — composes first-task prompt context, with branch-naming
  guidance only after execution verifies this Session's temporary branch in an ordinary
  new independent GitHub/local worktree.
- `acp-error-classification.ts` — JSON-RPC/transport error string matching for the above.
- `session-manager.ts` / `session.ts` / `session-sandbox.ts` / `terminal-manager.ts` —
  session and process lifecycle, workdirs, worktrees, sandboxed spawning, ACP terminals.
  Managed GitHub credential preparation excludes local projects and their worktrees;
  each managed runtime owns a scoped credential lease, retained across adoption.
- `session-start-stage.ts` — start step names and the user-visible failure text
  ([start failures](#start-failures)).
- `session-fork-service.ts` / `session-fork-operation-store.ts` — the fork saga and its
  machine-local marker store.
- `session-edit-and-resend-service.ts` — same-session replacement of the last normal User turn.
- `session-launch-config-resolver.ts` — durable launch config resolution.
- `workspace-git-service.ts` — observes checkout branches for local folders and worktrees,
  serializes reads/writes per owner Session, and publishes the last named branch. Execution
  binds, terminal turns, and authorized Code Collab activation/refresh use this service;
  observation requires neither a running agent nor a GitHub remote.
- `turn-post-processing-service.ts` — post-turn work (titles, notifications, diff stats,
  and the `workspaceDirty`/`workspaceUnpushed` probes that drive the Info Bar's
  Commit & Push action; both cancellation routes refresh the branch and run `syncWorkspaceGitState`,
  which self-gates on the session's GitHub binding).
- `session-diff-stats-target.ts` — chooses which writer owns a session's `diffStats`.
- `session-access-policy.ts` — local-first dispatch access precheck (optimistic-allow cache,
  D11). It may allow owner-cached turns from the catalog snapshot, allow a workspace member
  whose backend allow for the same local project is under one hour old, deny `remote_missing`
  workspaces, or return `remote` to preserve the existing Convex three-state path. Catalog read
  failures degrade to `remote`, never to an error.
- `session-access-retry.ts` — remote machine access verification: bounded retries at command
  validation boundaries and interruptible unbounded retries for an already-durable dispatch.
- `session-user-resolver.ts` + `git-identity.ts` — the requesting user's commit identity.
- `worktree/git-execution.ts` — native WorktreeGit service: command Scope,
  status/error distinction, environment/official filesystem and bounded helper probe.
  `git-execution-legacy.ts` executes that kernel for the Promise manager; remove its
  visible facade after the manager migrates. Infrastructure/release failure cannot
  authorize fallback or force removal. Setup/GC ownership remains separate.
- `worktree/` — repo checkouts, worktrees, branch allocation, setup scripts
  ([AGENTS.md](worktree/AGENTS.md)). `worktree-gc.ts` reconciles the Lody-managed
  worktree tree against Session state: archived or deleted root Sessions lose their
  directory (after a backup commit, branch kept); contract in
  [specs/session-worktree-lifecycle.md](../../../../specs/session-worktree-lifecycle.md).

## Background

### Frozen execution input

Create, continue and steer resolve effective input through shared
`resolveSessionExecutionInputBlocks`: the accepted turn's `prompt` owns text,
while `inputBlocks` provide structured attachments and retain authored text for
editing. Dispatch preserves both fields and supplies legacy history fallback.
Execution never reconstructs instructions from the current Role catalog. Runtime
context and attachment materialization remain daemon responsibilities. See the
[decision and regression evidence](../../../../.agents/notes/implemented/architecture/2026-10-08-frozen-turn-execution-input.md).

### Why turn activation has its own predicate

Fast-path turns that finish before their history entry syncs are reconciled by
`maybeRepairAlreadyHandledTurn`. Missing-history delivery recovery records
`lastMissingHistoryUserMsgId`, and a stale activation whose entry is already terminal is
retired into `settledActivationUserMsgId`. Both slots retire an activation while deliberately
leaving `latestUserMsgId` and `lastHandledUserMsgId` unequal, so a consumer that compares the
two pointers itself sees pending work forever: GC
never reclaims it, MCP reports a phantom queued turn. That is why
`hasPendingUserTurnActivation` in `@lody/shared` is the single answer, and why
`packages/shared/tests/dispatch-activation-predicate.test.ts` fails on any new comparison.

There is no CAS against the LWW map, so rewriting `latestUserMsgId` to retire an activation
would let a send published between the read and the write lose its activation and go unwatched
and unrun. The `settledActivationUserMsgId` slot may be replaced freely because the turn it
names is terminal.

The renderer derives a visible "not delivered" label for a marked entry from the marker plus
its non-terminal status — no CLI repair write, no schema change. Recovery is a fresh send: the
label opens a confirmation dialog that re-sends the SAME content as a brand-new message
through the ordinary producer path. The renderer retains the marker as a tombstone and
supersedes the abandoned entry to `canceled`; it must never revive the old turn.

### Bootstrap scan cost

Owned-session startup and meta bootstrap scans may cover thousands of rooms, and the scan is
idempotent but costs seconds of main-thread work. `enqueueBootstrap` folds concurrent requests
into a single queued drain (`pendingBootstrapReasons` + `bootstrapChain`); none are dropped. A
per-trigger scan is not acceptable because `onMetaRoomSynced` fires on Streams recovery, so a
misread transport edge would turn into an O(rooms) scan every few seconds. Coalescing bounds
the work per trigger, not the trigger rate; keeping that rate sane is the connection recovery
boundary's job, and `onMetaRoomSynced` is rate-limited in `../lib/loro/connection-recovery.ts`
while the cheap "back online" edge moved to `onStreamsOnline`
(context/code-collab-flow.md).

### Per-session check chain cost

The dispatch branch of a session check awaits the whole agent turn, and the session mirror
fires a check on every commit while the agent streams, so a long turn accumulates hundreds of
triggers behind the blocked chain. Each check re-reads the full history (about 130 ms on a
13 MB session doc) and settles every await on microtasks, so an uncoalesced drain pinned the
daemon for up to 42 s without ever reaching the timer phase. `enqueueSessionCheck` therefore
reuses a queued check that has not started yet — at most one follow-up per turn — and a check
that follows another one in the chain yields one macrotask first
([note](../../../../.agents/notes/implemented/bug-fix/2026-09-13-dispatch-check-coalescing.md)).

### Turn ordering

Turn-scoped history LIST writes (assistant entry, ACP flushes, finalization, failure notices)
wait until the user turn entry has synced into the CLI-local doc, because concurrent Loro list
inserts can otherwise permanently order the reply before the user message. Status and meta map
writes are never gated; some sit on the prompt critical path.

### Why the pointer write is bundled with the history append

`latestUserMsgId` is the producer-owned metadata activation, separate from history transport.
`SessionDocument.appendUserTurn` bundles history acceptance with publication so idle watchers
and startup can discover an ordinary send. Durable create and edit-and-resend publish their
own producer activation; execution start, completion, and steer handoff never rewrite it.

Refused steers use daemon-owned `steerTurnStatuses[userTurnId] = 'pending'`. A history-only
status change would not wake an idle watcher, while reusing the latest pointer could erase a
newer send. The shared activation predicate includes these exact-id pending records; ordinary
claim and missing-history failure acknowledge only that record. The same map retains steer
status/provenance until the exact history row arrives. Terminal projections clear their
records; applied processing stays recorded until execution ends. After restart, an abandoned
applied processing record becomes canceled, never an ordinary replay.

The execution service does not decide that interruption means non-delivery. AgentClient returns
`applied`, `not-applied`, or `unknown`; only `not-applied` can move a steer back to ordinary
dispatch, and only when the cancellation boundary selected `pendingInput: 'promote'`. User Stop preserves history and cancels queued execution eligibility; Edit & Resend and
access revocation also preserve pending input. Inbox recovery never revives pre-Stop input. `unknown` becomes `delivery_unknown` in history. The UI offers a
confirmed fresh send with a duplicate-work warning, never an automatic retry. RPC application
ACKs update presentation only; the execution service alone projects processing and terminal
steer status, so delayed ACKs cannot resurrect canceled or completed history.

Stop and target completion abort local steer waits before entering the serialized completion
lane. A submitted request keeps its late verdict outside that lane and its rewrite lease.
Raw prompt/steer requests and configuration work remain in the owner's five-second drain;
termination failure keeps ownership. Steer configuration checks the local signal before each
subsequent mutation. Already-applied handoff commits before queued completion can run.

Cancellation separately selects the pre-prompt process lifetime. Stop and access revocation
discard it; Edit & Resend keeps it because preparation has already created the replacement
inside that same ACP process. Creation/restoration retain their cancellation fences until
initialization completes; those fences must not override a later `keep` during configuration.
Binding a ready session alone does not authorize termination.

An ordinary user turn can retry a stale ACP prompt once before observing output.
Replacement uses the existing instance retirement path, which detaches lifecycle listeners
before terminating the old process. It keeps the same assistant entry and ACP output owner;
resume replay suppression must not follow a spurious turn finalization. Until retirement
succeeds, the runtime retains the old Session and the existing disconnected-execution release
path owns cleanup, including missing-session errors and Stop during retirement. A successful
replacement remains reusable. Inbox submissions keep their separate no-retry policy.

History promotion and activation can fail independently. `promotion-failed` preserves proof
of non-delivery. `recoveryOwned` tells the renderer not to publish a conflicting activation;
it retries that proven failure once through the daemon and surfaces persistent failure.
Legacy replies retain ordinary dispatch repair for pending_apply/pending/seen. Active,
terminal, and removed entries are left alone; unknown delivery never takes this retry path.

Foreground ACP configuration runs with the owner Effect's `AbortSignal`. Each mutation checks
that signal before the next mutation, so an old turn whose first configuration call finishes
late cannot overwrite the configuration of the turn that started after Stop.

Completion notifications use the exact completed invocation's input author, including
steer handoffs. An Agent-authored input suppresses the user-facing completion notice;
an earlier Agent input does not suppress a later human turn. Finalization, Operation
results and Inbox scheduling still run. Cancellation is rechecked after the author read.

### Why resume reopens the assistant entry

Teardown and cancel finalize (`message-handler.ts` `finalizeACPState`, no-turnId overload)
stamps `finished=true`/`endedAt` on the in-progress entry, and
`assistant-turn-finalize.ts` `markAssistantTurnFinished` is a no-op on an already-finished one
because those callers fire per live session at app close. Without the reopen reset, a
machine-death-then-resume turn streams new output into a `finished=true` entry: the web
renderer folds the still-streaming turn into a `Worked for …` summary and shared "active
assistant entry" logic (`@lody/shared` `schema.ts` terminal predicate) treats it as done.
Renderer side: [packages/components/src/components/ai-gui/AGENTS.md](../../../../packages/components/src/components/ai-gui/AGENTS.md).

### Why a resolved prompt is not proof of success

Nothing reads `PromptResponse.stopReason`, and an adapter may swallow an upstream failure and
resolve normally — observed: an over-context request answered with HTTP 400, kept only in the
agent's own session file — so `handleTurnError` never sees it. The no-output guard is the
backstop.

### Why output capture is mandatory for result-bearing spawns

`spawn()` does async post-spawn work (pid wait, resource profile, cgroup attach), and under a
stalled event loop a short command exits and its stdio is destroyed — dropping buffered output
— before the caller subscribes. `exec()` then resolves `''` and also ignores the exit code, so
a failed command is indistinguishable from an empty one. This is what made a session that had
just opened a PR report "detached HEAD" and never associate it. Long-lived ACP stdio
deliberately does not capture: it streams and would grow unbounded.

### Why an unsplit terminal command line falls back to `sh -c`

ACP `terminal/create` carries the executable in `command` and its argv in `args`, and that pair
is spawned directly. Some agents instead send the whole shell line in `command` with empty `args`
(a bare `ls -al`, or a relayed `bash -lc …`). Spawned literally, no such executable exists: on
Linux the cgroup sandbox awaits the child's pid and the agent sees an untyped errno `-2`, while
on the darwin fallback the handle resolves first, so `terminal/create` returns an id whose
`wait_for_exit` never completes.

The fallback is deliberately narrow — empty `args`, whitespace in `command`, and no file at
that path — so a spec-conformant call is untouched and an executable whose path contains a
space is still spawned directly. The shell is non-interactive and non-login (`sh -c`, not
`bash -lc`): the agent asked for one command, not for the user's login profile to run and
change its environment. A spawn that still fails answers with a JSON-RPC code instead of a bare
errno, and its error is recorded as an exit status so no waiter is left pending.

### Imported ACP identity

Continuation and fork use the shared `resolveSessionAcpTargetId` projection: a
Lody-owned runtime supersedes the immutable imported source; an unresolved source
history conflict cannot authorize native fork. Import does not fabricate a live
runtime id. Fork copies an ACP runtime configuration baseline only when it belongs
to the copied last user turn and source ACP identity, rebasing it to the new native
session id. Ordinary and worktree forks use the same projection and fence.

### Fork saga recovery

Because a preparing target publishes no Session meta until its final commit, the repo meta
index cannot name interrupted operations; recovery discovers them from the machine-local
marker store (`session-fork-operation-store.ts`), recorded fail-closed at accept and cleared
only after the final commit or rollback persists. The marker carries the worktree-cleanup
payload, so recovery never opens the source doc. A marker surviving startup is by construction
an anomaly, so recovery opens the named target doc and judges from it with the client's own
terminal criteria — never the meta record, whose write is not flush-atomic with the doc's. The
saga commits doc writes first (history BEFORE the flag clear) and publishes meta last, so a
durable `acpSessionId` implies the doc writes landed. A stale preparing flag with landed
history must be cleared, or the client's fork observer can reach neither terminal branch and
waits forever. Doc-landed-but-meta-missing is repaired by republishing meta from the marker
payload with `acpSessionId` absent.

Recovery must never enumerate session rooms or open docs to find candidates: each open joins
the room and pulls its stream, so a full scan is O(all historical sessions) of Streams
subscriptions at every daemon start (see [../lib/loro/AGENTS.md](../lib/loro/AGENTS.md)).

### GitHub credential broker

Managed GitHub sessions receive a trusted conversation-owner snapshot and workspace
Git/gh adapters from `session-manager.ts`. The shared credential iterator tries
personal, eligible machine and repository App sources once, without a cloud policy
lookup. The broker supplies optional managed tokens; owner-local credentials remain
available during token-service failure. Native Git helpers use `GIT_EXEC_PATH`;
standard URLs remain standard. Host operations pin the same owner snapshot through
checkout. Managed credential helpers also cover checkout filters and LFS; non-owner
host children scrub inherited GitHub tokens. `session-credentials.ts` bridges the
broker's Effect-scoped acquisition into the existing Promise Session lifecycle.
Each acquisition has its own token and pinned file; neither enrollment nor release
uses a Session ID lookup. `SessionConfig` carries no credential policy. Session
creation owns the lease and a failed creation releases it. Validation on create,
continue, recovery and steer checks that runtime's lease and trusted owner. Owner
changes revoke it and retire the old runtime, since children retain their old
environments. Operations are not replayed.

See [the contract](../../../../specs/github-identity-fallback.md) and
[worktree rules](worktree/AGENTS.md) for ownership, write non-replay and isolation.

### Commit identity

`git-identity-policy.ts` bounds the complete policy lookup to 3 seconds per attempt,
retries once, and returns personal identity disabled after two failures. Startup publishes
`Resolving Git identity`; cancellation interrupts the waiter and fences identity updates
and agent launch. Late policy results have no side effects. This deadline also covers
per-turn identity refresh; it is separate from network credential fallback.

The effective identity becomes `GIT_AUTHOR_*`/`GIT_COMMITTER_*` in the session env (`session.ts`
`updateGitIdentity`, re-applied per turn via the execution service's `bindReadySession`). When
the turn requester is the machine owner, the repository/machine Git identity is used without a cloud profile lookup; missing local
identity uses neutral LodyAI. Non-owner profile queries have a 60-second deadline; failed or
timed-out entries are evicted so later turns can retry. A non-owner requester always uses their resolved
Lody/GitHub identity and can never inherit the machine owner's Git config; if no usable requester
identity exists, the neutral LodyAI identity is used. The cloud composition root owns hosted
user resolution because the daemon does not own an end-user browser session; the local access
port resolves only its synthetic owner and never performs network I/O. PR and push identity
itself comes from the conversation-owner GitHub credential, not from git config. Identity
changes update the host Session environment without restarting ACP or its sandbox.
Existing ACP children retain their launch environment; live
identity propagation into adapter-owned Git commands remains unresolved.

### Start failures

`SessionManager.createSession` reports each start step through `onStartStage` as it
begins: credentials, working directory, worktree, worktree setup script (reported only when a
script actually starts), agent sandbox, Git identity, agent runtime, then agent start. The execution service keeps the last step on the turn and clears it once a Session
is bound. A failure is recorded as `<step> failed: <message>`, using
`session-start-stage.ts`, so the user sees where start-up stopped. Authentication failures
keep their own message. The error itself is never wrapped: the restore and create paths
classify it by identity to choose sign-in, the history-replay fallback or a generic failure.
When a start fails, cleanup terminates the partial Session and releases its credentials.
Each cleanup failure is logged, and the original error is rethrown. These are rules:
never wrap the start error, and never let cleanup replace it. Failure text uses
`formatReportedError`, which names the type and cause of an error whose message is empty,
which a `Data.TaggedError` without a message getter produces. Only Error and string causes
are described. Classifiers keep using `formatErrorMessage`, whose output does not change.
See the
[decision](../../../../.agents/notes/implemented/bug-fix/2026-10-16-session-start-failure-attribution.md).

`startWithTransientRetry` in the execution service starts again after a temporary OS
failure (`EAGAIN`, `EMFILE`, `ENFILE` or `ENOMEM` anywhere in the cause chain), up to three
attempts with 1- and 3-second delays from `SESSION_START_RETRY_DELAYS_MS`, each jittered
over its upper half. Before each delay it publishes `Retrying after a temporary system error`
as presence detail, and after the delay it checks for Stop. Each attempt is a fresh
`createSession`. A failed attempt whose cleanup could not terminate its agent or release its
credentials is marked (`recordIncompleteStartCleanup`) and never retried. The whole
service shares `SESSION_START_RETRY_BUDGET` (6 retries per minute), because a temporary OS
failure usually hits every Session at once. `sessionStartRetryMode` decides how to repeat.
A new Session repeats unchanged if it failed before its worktree setup script. If it got past
the script, it repeats as a resume, which skips the script. It never repeats if it failed
while the script was running. A restore always repeats unchanged, because its existing
worktree already skips setup. Authentication, resume and every other error fail on the first
attempt. See the
[retry decision](../../../../.agents/notes/implemented/feature/2026-10-16-session-start-transient-retry.md).

### No draft preparation

Every Session starts its ACP process and worktree when its first turn is dispatched.
Draft preparation, which started both while the user typed, was removed: its runtime was
almost never adopted, and discarding it cost more than a cold start
([decision](../../../../.agents/notes/implemented/simplification/2026-10-16-remove-draft-session-preparation.md)).
`session/prepare` and `session/prepare-cancel` still parse, because older desktops send
them. The daemon answers both at once without work; prepare reports an accepted duplicate
so an older desktop holds one lease per draft instead of re-asking after every pause.
`worktree/legacy-speculative-worktrees.ts` handles worktrees an older daemon prepared:
creation claims the Session's marker and reruns setup on its worktree. Only a worktree no
Session adopted is rebuilt for a target mismatch: an adopted one keeps its branch, which
resume restores by name. A sweep removes orphans whose Session never became durable.

Memory identity references travel with turn configuration. `Session.createAgent` maps
them through `../lib/memory-providers.ts` at spawn; the execution service restarts a
resident ACP process when the next turn changes identity. See the
[memory Spec](../../../../specs/agent-role-memory.md).

## Roost history paging

The CLI uses the pinned `@loro-dev/roost-node` npm runtime for SQLite history in a
Worker. Electron stages that complete package with one target native binding.
The shared renderer uses the existing local IPC or remote history RPC bridge;
Web/iOS clients need no Node addon. The owning machine must be available for RPC
reads; browser-local IndexedDB replicas and offline sync are separate work.
Runtime packaging and verification: [native runtime note](../../../../.agents/notes/proposed/architecture/2026-10-09-roost-native-runtime.md).

### Incremental replica recovery

`sessionHistoryIncremental` v1 is negotiated separately from existing history paging.
Checkpoint-bearing pages opt in with `withCheckpoint`; legacy page replies remain unchanged.
`readChanges` verifies the previous checkpoint and returns complete changed identities plus
any affected structural suffix, or an explicit reset. The native owner's local index records
semantic change receipts after verifying the corresponding raw event interval. Receipts
contain no history body, signing material or executable command, and emit no outgoing event.
A crash or foreign mutation that leaves an uncovered interval requires reset. A checkpoint
cannot claim acceptance or execution, and must not be copied between unrelated owner views.

Normal repairs request affected bodies with the change interval in one reply, bounded at
500 changed/suffix bodies. Larger repairs use checkpoint-protected ranges. The renderer
atomically commits bodies, positions, revision and checkpoint. Coherent replies may advance
behind newer control hints and immediately catch up again, so streaming does not need to
stop for a stable observation. Body-only edits retain cached directory cursor validity.
A successful delta repair finishes even for a partial tail cache, without rereading
the unchanged latest page.
The previous coherent projection remains readable on failure. Supersession retries immediately; storage and transport
failures retain recovery backoff. Initial population, legacy targets and unknown coverage
retain staged rebuilding. Local control reads have a separate bounded pool from writes;
remote RPC reserves write/control pools and rejects excess ordinary work without blocking
send intake. Detailed decision and verification:
[Roost incremental recovery](../../../../.agents/notes/implemented/bug-fix/2026-10-16-roost-incremental-history.md).

An explicit checkpoint reset forces replacement in the other cache slot even when
its control revision is equal or consecutive. Last-change hints cannot repair unknown
coverage. Replacement pages share one checkpoint, and the old snapshot remains readable
until every replacement page is durable; failed staging retains that recovery mode.

Cold readers observe backend metadata before composition; provisional absence remains
pending until explicit identity or the session's selected metadata source restores.
An empty history list is not legacy evidence. Owner capabilities remain live.
Restoration is a finite identity barrier; a still-missing owner or a known Roost
cursor waits for metadata changes rather than selecting legacy history.
Independently negotiated `sessionHistoryWatch` v1 observes the committed checkpoint
through local `watchChanges` or encrypted remote `session/history-watch`. Publication
wakes the wait immediately; a 15-second deadline bounds idle waits without occupying
the native Worker or writer queue. Actual body reads acquire bounded read capacity after
waking, and idle replies transfer no history bodies. Active readers therefore recover
without relying only on control-cursor hints. Each bridge owns one refresh; release and
hidden/offline remote views stop new observations. Local IPC remains usable offline.
[Peer-reader readiness and observation](../../../../.agents/notes/implemented/bug-fix/2026-10-16-roost-peer-reader-readiness.md)
records the lifecycle, protocol limits and verification.

### Immutable input acceptance

Ready renderer input uses `SessionData.inputAcceptance`: `accept_input` writes
one immutable operation receipt with its history mutation, and the
`inputAcceptance` history query reads that original outcome. It is advertised
separately as `sessionInputAcceptance` version 1. Older targets require an update;
ordinary history capability alone does not imply support.

Ordinary ready input additionally negotiates `sessionInputDispatch` v1 and uses
`accept_input_and_dispatch`. Its native writer queue records trusted human provenance,
accepts immutable history and publishes activation for the latest awaiting user
input before replying. Removed/settled input, archived/deleted metadata and the
missing-history tombstone never reactivate; retry does not move a newer pointer back.
The RPC host wakes its existing history dispatcher without awaiting execution or
transport sync. The sender can show delivery from the owner receipt without reading
history back or offering another dispatch RPC. A lost reply still queries the
original receipt and repeats only the same immutable combined operation.

The operation freezes user, turn ID and prepared content. Its digest excludes
mutable parent/head placement. The owner checks current and retired history
receipts before a write, so a retry converges with a delayed original after later
appends or generation replacement. A removed accepted turn returns `active:false`
and is never recreated. These receipts confirm owner history only; dispatch and
guide application retain their existing execution boundaries.

### Roost writer identity

Each Node history database has a separate host-private identity database at
`<history path>.identity.sqlite3`. Its versioned seed/public-key pair is created once
inside an immediate SQLite transaction, committed with `synchronous=FULL`, and read
back before the history Worker starts. Independent processes reuse the winning
identity. On POSIX the identity file is private (`0600`); Windows relies on the
application data directory's account ACL. Neither seed nor identity metadata enters
history streams, exports, RPC or diagnostics. Back up the history database and its
identity database together, using a consistent SQLite backup while writers are stopped.

The execution replica signs physical Turns, while each input retains the actual
human `userId` and `author`. Multiple users and devices access a shared execution
machine through the existing authorized history RPC; clients do not copy its seed.
An independently writable local machine gets its own identity. This change does
not compose cloud history replicas or enable offline input submission.

Roost never opens the system keyring or reads `LODY_ROOST_SEED_HEX`. Login credentials
keep their existing protection. Normal logout and renderer cache clearing do not
delete the Node writer identity. Missing, invalid or conflicting identity data
rejects initialization without replacing the key, changing backend or replaying work.

Nightly keyring migration is deliberately unsupported. An existing history database
without the paired identity database is refused before the history Worker starts;
its bytes and keychain entries remain untouched. To test the new format, stop the
daemon and select a new, unused `LODY_ROOST_DB_PATH` on the execution machine. Do not
expect old keyring-backed conversations to become available in the fresh database.
Failures carry `identityMissing`, `identityInvalid`, `identityConflict` or
`identityStorage` and the existing diagnostic reference. The native identity service
owns a short-lived SQLite handle; its deprecated `loadRoostOwnerSeedLegacy` facade
remains until the Promise owner pool receives the service from the daemon runtime.

### Paging and observations

History RPC requires matching session ID, owning machine and persisted Roost backend
before opening a cold store. Local creation commits do not establish arrival at the
target daemon: metadata and RPC use independent streams. The scoped, session-specific
readiness barrier waits at most ten seconds; confirmed foreign/deleted identities
still refuse access, and a readiness deadline never starts a history operation.
Server stop/MessageHandler cleanup cancel the wait without stopping shared sync.
Pending/ready diagnostics record ownership/backend state and elapsed wait time;
RPC rejections correlate that context with the request ID. Transport failures retain
client-side provenance and do not establish an owner storage fault or authorize replay.
Compose the readiness Effect directly; only the MessageHandler entry executes it.

An explicit history precondition refusal must remain terminal when the RPC stream
replays an unexpired request after daemon restart. `session-history-rpc-rejections.ts`
owns a separate SQLite file in the application data directory, with one scoped handle
per operation and a FULL synchronous transaction before the refusal reply. It stores
only the request namespace, fingerprint, expiry, code and safe message. It never stores
history bodies or credentials. Expired records are removed on the next refusal write.
The MessageHandler RPC callbacks execute these Effects; the transport requires this
capability for history writes and refuses unavailable or conflicting request state.
Storage handoff and uncertain write outcomes retain their existing owners.

Initialization, Worker exit and failed writes retain their original error and outcome
classification. The owner's local log records causes, exit status and runtime/build
details under a diagnostic ID. For these failures, history RPC returns only the ID,
stage and error code in its existing error string; the shared renderer explains the failure in the
selected language. Failures neither change the stored backend nor replay a write whose
outcome is unknown.

Renderer read replies bind logical page bodies, count and history revision to
one durable observation. The RPC waits for local writes before and after the
read and retries a moving revision; neither barrier waits for remote sync.
This lets the renderer persist bounded pages as a coherent offline read replica
without exposing physical segments or introducing another history writer.

Display bootstrap and ordinary directory/body reads use active-branch pages and
a bounded body cache. Published-message pages cannot establish branch membership.
Resolve an off-window physical head before sealing or appending; a late successor
must not turn the next append into a new root. Full snapshots belong to explicit
export/copy/edit operations, not renderer hydration or missing-new-ID lookup.

The owner starts with 40 logical turns and keeps up to 500 page bodies for subsequent
hydration. Reverse pages carry their own total count and absolute positions. Cursor
rejection after a branch rewrite is recoverable by refreshing the loaded window;
it never authorizes switching back to Loro or reading a superseded published suffix.

ACP batch appliers can mutate item arrays. The Roost adapter applies them to a
detached working copy, preserving the before-image used to decide what to persist.
Content changes refresh only affected primary bodies. Sealed-turn corrections
use mutable SDK state records anchored to their primary; permission responses
remain independent SDK records projected onto the matching tool. Responding does
not seal the assistant or interrupt its output.
Existing eligible unsealed primary/state records use guarded native field/text edits,
with compact publication digests in `lody_agent_operation_receipts_v1`, committed in
the same `writeBatch`. This owner-local journal has no command/body/baseline snapshots;
lookup retains previous SDK receipts and generation ancestors. Creation, stitched or
sealed targets, permissions, immutable human input and branch contracts retain their
SDK path. A failed native write never falls through to a second write path.
Native inserted items/fields use the same JSON encoding as SDK content: absent object
fields are omitted and absent array values become `null`. Normalize only changed
subtrees; unchanged message bodies are not serialized for each delta. The semantic
change receipt starts at the command's initial cursor, even when its bounded ACP
batches advance the native write guard between chunks.
The [write-amplification repair](../../../../.agents/notes/implemented/bug-fix/2026-10-16-roost-storage-write-amplification.md)
records storage budgets and the unchanged existing-data/outbox retention limits.
Ordinary Edit & Resend reuses the sealed prefix through the SDK's branch activation
inside the same stream/view. The Lody session id and owner saga do not change.
An application-owned signed epoch commits in that native transaction and fences
older handles. Immediate rollback restores the old SDK head; rollback with later
appends retains the existing whole-generation compensation. General structural
copy/import edits still stage a complete SDK-managed generation and publish one
signed application-owned activation with a native event-cursor CAS. Failed staging
retains the old stream; sealed envelopes and SDK indexes are never rewritten.

The local goal projection is an optional derived index tied to an exact native
event cursor. Incremental page coverage or a complete read establishes its value;
commands advance it only across their own signed write receipts and index events.
Unknown, damaged or externally invalidated projections require an authoritative
read before the active-goal guard. This cache never accepts commands or weakens
eligibility. Its failed CAS affects reuse only. Historical state/permission reads
use eight concurrent lanes; a lane issues at most one native request at a time.
Per-item ACP receipts commit with their output and remain discoverable through
prior generations, so a lost reply or overlapping retry cannot replay a prefix.
Count and position reads refresh after a lost activation reply. The local write
barrier republishes the committed projection before RPC binds its control revision;
it never retries an indeterminate history action.
External cursor refreshes share the local write queue so an earlier branch read
cannot overwrite a later mutation's projection; disposal rejects pending reads.
Cloud one-shot managers inject owner RPC services and never open a caller-local
Roost database. The cloud daemon routes per Session: another machine's Sessions use
owner RPC, its own (or not-yet-known owners) use the installed local owner, and the
routing leaves its execution documents' auto-read policy unchanged. Open-ended directory reads clip to the owner count and use at most
500 rows per RPC, restarting when the durable revision moves. Fork and Edit & Resend
retain their owner sagas; process-local snapshot/rollback handles do not cross RPC.
The production SQLite regressions live in
[`roost-session-backend-contract.test.ts`](../../tests/roost-session-backend-contract.test.ts).
The synthetic [history benchmark](../../benchmarks/roost-history.mts) exercises
these production backends and the shared view; `BENCH_STRUCTURAL=1` also measures
the complete directory and a guarded last-user edit. Its timing excludes renderer
transport, IndexedDB and paint.
The synthetic [send benchmark](../../benchmarks/roost-send.mts) compares a first
input and three follow-ups through production owner backends, recording acceptance
and the observer's `seen` status separately. Run it from `apps/cli` with
`TSX_TSCONFIG_PATH=tsconfig.json node --import ./node_modules/tsx/dist/loader.mjs benchmarks/roost-send.mts`;
`BENCH_SAMPLES`, `BENCH_WARMUPS` and `BENCH_OUTPUT` control the run and JSON report.
`BENCH_DISPATCH=1` selects combined Roost acceptance/activation and verifies the
resulting activation pointer; dispatcher and Agent startup remain excluded.
Roost includes SQLite/signing; Loro uses an in-memory Repo, so the result compares
current owner paths with different durability costs, not equivalent storage engines.
It excludes transport, source IndexedDB, dispatch, rendering and execution startup.

Worktree observations use the native `WorktreeObservations` service: official
filesystem, WorktreeGit and the existing FileLocks coordinator. The Promise manager
executes them through `runObservationLegacy`; list/inspect own repo leases, while
mutation information reads reuse the caller's lock. Missing and unborn state remain
distinct from repository/infrastructure failures. See the
[decision](../../../../.agents/notes/implemented/architecture/2026-10-10-effect-worktree-observations.md).

Local-shared `ensureRepo`/creation consumes `LocalWorktreePreparation`: source
validation, directories and complete metadata publication use native FileSystem,
WorktreeGit and Clock under the caller's existing repo lease. `runWorktreeLegacy`
executes this and observation programs through the same FileLocks runtime; a failed
metadata scratch release retains its path and bounded retry capability. Bare
clone/fetch, full mutations and long-lived GC still require their own native owners.

## Conversation-tree stop

The related-conversations action persists `collaborationStopped` on the creation tree.
Execution reads inherited flags before setup and ACP dispatch. Metadata updates
cancel exact active turns with pending input preserved, while late completions are
recorded without continuation. Users must explicitly restore collaboration; offline
machines enforce the state after sync. See the [orchestration contract](../../../../specs/session-orchestration.md#user-controlled-conversation-tree-stop).

## Operation result input

The independent Inbox supplies one batch reference beside an intact ordinary input.
All visible turns share its admission, including existing goal turns with their own
synthetic input identity; goal controls/configuration are otherwise preserved. Stop
persists pause and cancels pre-Stop queued eligibility. Fresh human entry may retry
retained physical cleanup, but cannot dispatch until proof of release. Runtime ownership
lasts through durable release/settlement, so a Stop during final release can veto the
automatic intent. Post-fence human-plus-batch input cannot use stale-ACP replay.

Human send authorization also lives in the Session control document's
`humanInputReceipts` map. UI and non-delegated CLI entry points stamp it before
activation; execution restores the matching receipt through ordinary history dispatch.
RPC is redundant, including for large inputs. Generic history imports and Agent chat
do not stamp this map, and canceled/terminal input IDs cannot clear a later pause.

Stop details occupy one replaceable `cancelRequest` slot in the Session control doc.
The existing `lastCanceledTurn` metadata field carries only `cancel-request:<id>`;
legacy values still directly name a turn. Publish that marker after persisting the
payload. The watcher waits for matching control data and checks control arrivals on
its separate cancellation chain. RPC uses the same ID, so a late fallback cannot
pause fresh input again; a second click gets a new ID even for the same target turn.

The Session sandbox persists incomplete identity before spawn and continuously adds
ACP/terminal process roots. Execution retains every attached Session owner until release,
including replacements within one turn. Restart probes require explicit completeness and
absence of every root/group; an initial snapshot alone is insufficient.
A child error with no PID proves that spawn created no process: it still rejects
the command, but does not make resource identity permanently incomplete. This
exception matches the actual child error; journal, setup and cleanup failures
remain uncertain, as do other acquisitions already marked uncertain.
