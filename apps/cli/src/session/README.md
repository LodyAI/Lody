# apps/cli/src/session

Session lifecycle on the daemon side: watching for user turns, running them through an ACP
agent, and the sagas around them (fork, edit-and-resend, preparation, worktrees). Binding
rules live in [AGENTS.md](AGENTS.md) and [worktree/AGENTS.md](worktree/AGENTS.md); this file
is the responsibility index and background.

Dispatch architecture: context/message-flow.md — user turns arrive by being written into the
session doc (meta pointers), not via a message bus. The WS/DO path is DEPRECATED. The
CLI/MCP orchestration contract is specs/session-orchestration.md.

| Boundary         | Owner                                             | Responsibility                                                       |
| ---------------- | ------------------------------------------------- | -------------------------------------------------------------------- |
| Admission        | [Dispatch watcher](session-dispatch-watcher.ts)   | Resolves metadata activation against history, queue, and RPC offers. |
| Execution        | [Execution service](session-execution-service.ts) | Owns turns, steer results, cancellation, and raw-request drain.      |
| Process lifetime | [Session](session.ts)                             | Owns ACP resources and confirmed termination.                        |

## Files

- `session-dispatch-watcher.ts` — the current dispatch entry: watches
  `repo.watch('doc-metadata')` plus a per-session mirror subscribe and dispatches when
  the shared pending-activation predicate identifies work. Also accepts `session/dispatch-turn`
  Machine RPC pushes via `offerRpcTurn`, which stash the payload as a third turn source
  (history → queue → stash) and wake the per-session check chain. That RPC ack means delivered, not
  authorized or executed. Its extensive header comment
  is the authoritative doc for edge cases (stale pointers, history/meta sync races).
- `session-dispatch-logic.ts` — pure decision functions for the watcher (testable).
- `turn-history-gate.ts` — ordering barrier for RPC fast-path turns. Created in
  message-handler's `beginConversationTurn`, stored/disposed via `SessionTransientStore` turn
  state; it creates the assistant entry when it opens.
- `session-execution-service.ts` — runs one turn end-to-end: ACP prompt, turn ids,
  lifecycle/error handling, GitHub/local project setup, and post-turn diffStats.
- `acp-error-classification.ts` — JSON-RPC/transport error string matching for the above.
- `session-manager.ts` / `session.ts` / `session-sandbox.ts` / `terminal-manager.ts` —
  session and process lifecycle, workdirs, worktrees, sandboxed spawning, ACP terminals.
- `session-preparation-service.ts` — process-local speculative ACP lease/state owner.
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
  D11). It may allow owner-cached turns from the catalog snapshot, deny `remote_missing`
  workspaces, or return `remote` to preserve the existing Convex three-state path. Catalog read
  failures degrade to `remote`, never to an error.
- `session-access-retry.ts` — remote machine access verification: bounded retries at command
  validation boundaries and interruptible unbounded retries for an already-durable dispatch.
- `session-user-resolver.ts` + `git-identity.ts` — the requesting user's commit identity.
- `worktree/` — repo checkouts, worktrees, branch allocation, setup scripts
  ([AGENTS.md](worktree/AGENTS.md)). `worktree-gc.ts` reconciles the Lody-managed
  worktree tree against Session state: archived or deleted root Sessions lose their
  directory (after a backup commit, branch kept); contract in
  [specs/session-worktree-lifecycle.md](../../../../specs/session-worktree-lifecycle.md).

## Background

### Why turn activation has its own predicate

Fast-path turns that finish before their history entry syncs are reconciled by
`maybeRepairAlreadyHandledTurn`. Missing-history delivery recovery records
`lastMissingHistoryUserMsgId`, and a stale activation whose entry is already terminal is
retired into `settledActivationUserMsgId`. Both slots retire an activation while deliberately
leaving `latestUserMsgId` and `lastHandledUserMsgId` unequal, so a consumer that compares the
two pointers itself sees pending work forever: auto review waits on a finished session, GC
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
dispatch, and only when the cancellation boundary selected `pendingInput: 'promote'`. User Stop
selects promotion, while internal cancellation such as Edit & Resend and access revocation
preserves the pending input. `unknown` becomes `delivery_unknown` in history. The UI offers a
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

History promotion and activation can fail independently. `promotion-failed` preserves proof
of non-delivery. `recoveryOwned` tells the renderer not to publish a conflicting activation;
it retries that proven failure once through the daemon and surfaces persistent failure.
Legacy replies retain ordinary dispatch repair for pending_apply/pending/seen. Active,
terminal, and removed entries are left alone; unknown delivery never takes this retry path.

Foreground ACP configuration runs with the owner Effect's `AbortSignal`. Each mutation checks
that signal before the next mutation, so an old turn whose first configuration call finishes
late cannot overwrite the configuration of the turn that started after Stop.

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

Agent `gh` auth for GitHub repo sessions is set up in `session-manager.ts`: it creates the git
credential broker, prepends the `~/.lody/bin/gh` shim, and injects/refreshes a managed
`GH_TOKEN` when no user token is present. The shim lives in `../lib/gh-shim-script.ts`; token
fetching/caching is in `../lib/github-token-manager.ts`; git HTTPS auth uses
`../lib/git-credential-helper-script.ts`. Session process trees are already correct —
`prepareGitHubRepoSessionConfig` injects the env explicitly. The host-side rule is in
[worktree/AGENTS.md](worktree/AGENTS.md).

### Commit identity

The effective identity becomes `GIT_AUTHOR_*`/`GIT_COMMITTER_*` in the session env (`session.ts`
`updateGitIdentity`, re-applied per turn via the execution service's `bindReadySession`). When
the turn requester is the machine owner, the repository/machine Git identity is used without a cloud profile lookup; missing local
identity uses neutral LodyAI. Non-owner profile queries have a 60-second deadline; failed or
timed-out entries are evicted so later turns can retry. A non-owner requester always uses their resolved
Lody/GitHub identity and can never inherit the machine owner's Git config; if no usable requester
identity exists, the neutral LodyAI identity is used. The cloud composition root owns hosted
user resolution because the daemon does not own an end-user browser session; the local access
port resolves only its synthetic owner and never performs network I/O. PR and push identity
itself comes from the requester-bound GitHub token, not from git config. Identity changes update the host Session environment without restarting ACP or its sandbox,
including adopted preparations. Existing ACP children retain their launch environment; live
identity propagation into adapter-owned Git commands remains unresolved.

### Speculative preparation

Peek and claim are synchronous published-resource snapshots. A prepared resource may reuse its
open target-machine Flock to synchronously resolve launch config, but dispatch and claim
rescan the current row. Durable creation claims the marker only when repo, source, and base
branch target identity match, runs setup, then permits the first prompt.
