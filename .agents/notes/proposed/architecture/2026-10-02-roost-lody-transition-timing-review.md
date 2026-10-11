# Roost/Lody history backend transition timing review

Status: proposed
Translation: current

[中文](2026-10-02-roost-lody-transition-timing-review.zh.md)

## Abstract

The Roost transition adds an asynchronous history backend behind Lody's existing
session lifecycle. This note is the living review record for ordering bugs at
that boundary: a finding is recorded only when a concrete interleaving reaches a
wrong durable result or a user-visible turn result. The current review confirms
six P1 risks involving worktree fork backend selection, permission deadlines,
turn finalization identity, metadata ledgers, steer submission, and cold-start
backend identity. F5 now has a pre-submission fence in the working tree and a
deterministic regression test; the other open findings still require their own
fences and verification.

## Purpose and review rule

Use this note as the starting point for every later Roost/Lody review. Do not
restart from conversation history or copy an unverified concern into the finding
list. A candidate enters **confirmed findings** only when all of the following
are written down:

1. The exact participating operations and their `await`/callback boundaries.
2. A legal interleaving that can be reproduced by delaying one boundary.
3. The incorrect durable state or user-visible result produced by that
   interleaving.
4. Whether the current change introduces the race, widens an existing window,
   or leaves it unchanged.
5. The smallest ownership or identity fence that prevents the result.

Performance, code smell, generic adapter concerns, and risks that cannot be
connected to an incorrect result stay out of the confirmed list. A finding is
not closed because CI is green; it is closed only after the code and a
deterministic test or equivalent execution trace establish the fence.

## Review scope and baseline

The current review covers branch `lody-roost-local-merge` at commit
`47ff40c76edaa2bb9e654b19cfde3be2b78e0c53` (`test: stabilize CLI backend
boundary fixtures`) against `origin/main`. The implementation tree has no
uncommitted changes and matches `origin/lody-roost-local-merge`; the two review
documents created by this review are still untracked.

The intended rollout is that newly created sessions select Roost for their
history while legacy sessions remain Loro-backed. A backend discriminator in
session metadata is therefore session identity. The Loro control document may
continue to carry control-plane state, but history reads and writes must follow
the selected backend for the lifetime of an opened session document.

The review is limited to the transition and the surrounding queue, steer,
permission, fork, and turn-finalization paths. It does not claim that the Roost
adapter itself is incomplete: the adapter implementation is outside this
branch's evidence and must be reviewed through the same port once registered.

## Confirmed findings

### F1 — Worktree fork publishes acceptance before publishing the backend identity

**Status:** open; introduced by the transition changes; user-visible once a
Roost factory is registered.

**Code path:**

- `apps/cli/src/session/session-fork-service.ts` worktree path around the
  `targetMeta`/`marker` construction and `setImmediate` call.
- `packages/components/src/providers/create-workspace-runtime.ts` in
  `createSessionStore`.
- `packages/components/src/components/sessions/session-detail.tsx` in
  `PendingWorktreeForkObserver`.

**Interleaving:**

1. The daemon derives `targetMeta.historyBackend = 'roost'` and opens the target
   document with that option.
2. The worktree path records the recovery marker and the fork operation, then
   schedules `executeWorktreeFork` with `setImmediate`. It returns the accepted
   fork response before the target catalog metadata is upserted.
3. The renderer receives the response and mounts
   `PendingWorktreeForkObserver`. Its `useSessionDoc(targetSessionId)` opens a
   cold store before the target metadata row is visible.
4. `resolveSessionHistoryBackendKind(undefined)` selects legacy Loro. The store
   binds that choice for its lifetime; a later metadata update does not replace
   the already-created history view.
5. The daemon eventually imports the snapshot through the Roost backend and
   publishes `historyBackend: 'roost'` with the completed target metadata.
6. The observer remains attached to the Loro history. It cannot see the Roost
   `session_fork_origin` notice, so completion can remain pending or render an
   empty/wrong history.

**Why this is a transition finding:** the target metadata delay is present in
the asynchronous worktree fork path introduced for backend-aware forks. The
ordinary fork path writes metadata before opening the target document. The
problem is not that a renderer defaults to Loro for an old document; it is that
the renderer commits to Loro while the daemon has already selected Roost.

**Required fence:** return the backend kind in the accepted fork response and
compose the renderer store from that identity, publish target metadata before
allowing the observer to open the store, or refuse to create a history store
until the backend discriminator is known. A later metadata patch alone is not a
fix because the store's backend is intentionally immutable after creation.

### F2 — Permission timeout has no deadline ownership fence

**Status:** open; widened by the asynchronous backend calls; user-visible.

**Code path:**

- `apps/cli/src/lib/message-handler.ts` permission waiter around
  `checkAutomaticOutcome`, `resolveWithOutcome`, and the timeout callback.
- `apps/cli/src/lib/acp/history.ts` `updatePermissionOutcomeInHistory`.
- `packages/shared/src/history-writer.ts` conditional `respondPermission`.

**Interleaving:**

1. A permission request is waiting. Automatic approval is enabled after the
   initial check, so `checkAutomaticOutcome(true)` starts an asynchronous
   history read.
2. The timeout fires while that read is pending. It sets
   `timedOutResolution = true` and starts the conditional `cancelled` history
   write, but it does not reserve resolution ownership.
3. The automatic read returns with no stored outcome and obtains `selected`.
4. The automatic path enters `resolveWithOutcome(selected, ..., true)` before
   the timeout write has committed. Its conditional write wins and resolves the
   ACP permission promise as `selected`.
5. The timeout write then observes the already-set outcome and cannot overwrite
   it. Its later `resolveWithOutcome(cancelled)` is ignored because the promise
   is already resolved.

The result is that a tool can execute after the configured permission deadline.
The existing writer correctly prevents two committed outcomes from overwriting
each other; the missing piece is deciding who owns the deadline before either
asynchronous write completes. Before the backend transition the automatic check
resolved its in-memory waiter before yielding, so this specific window was not
opened by the old synchronous read path.

**Required fence:** the timeout must atomically claim resolution ownership, or
the backend must provide a single conditional winner that both paths obey. The
automatic path must re-check the deadline and adopt the committed winner before
returning an ACP response.

### F3 — A no-`turnId` finalizer can finish a replacement session's new turn

**Status:** open; identity gap existed before this branch and the asynchronous
backend path widens the suspension window; user-visible.

**Code path:**

- `apps/cli/src/lib/message-handler.ts` `error`, `exit`, `terminated`, archive,
  child-cleanup, and `flushAllACPUpdates` callers of
  `finalizeACPState(sessionId)`.
- `apps/cli/src/lib/message-handler.ts` `finalizeACPState` and its unconditional
  no-`turnId` `clearACPState` branch.
- `packages/shared/src/session-data/assistant-finalize.ts` and the backend
  `finish-assistant` action.
- `apps/cli/src/session/session-manager.ts` event handlers that delete the old
  session instance before emitting `exit`/`terminated`.

**Interleaving:**

1. An old session instance exits. `SessionManager` removes it from its map and
   emits `exit`; the message handler starts the no-`turnId` finalizer.
2. The finalizer pauses at the turn-history gate, ACP flush, or an asynchronous
   backend history write.
3. The execution service receives a new chat for the same session ID. Because
   the manager no longer has the old instance, `continueSession` enters
   `restoreMissingSession` and creates a replacement session. The replacement
   opens a new assistant entry and turn.
4. The old finalizer resumes and sends `finish-assistant` without an exact
   `turnId`. The action searches from the last assistant entry, which is now the
   replacement entry, and marks it finished.
5. Its no-`turnId` `clearACPState(sessionId)` clears the replacement's transient
   turn state as well.

The replacement's output can therefore be stamped terminal and its ACP target
cleared by an event belonging to the old instance. The existing
`finished === true` guard avoids re-stamping an already finished entry, but it
does not protect a newly opened replacement entry.

**Required fence:** lifecycle finalizers must carry the exact turn identity. A
teardown without an identity may only perform cleanup that cannot touch the
current turn; `finish-assistant` and ACP-state clearing must both verify the
same identity.

### F4 — Durable metadata ledgers use lost-update read/modify/write

**Status:** open; introduced by the durable ledger additions; user-visible after
restart or recovery.

**Code path:** `apps/cli/src/lib/loro/doc.ts` methods
`setQueuePromotionRecord`, `replaceSteerTurnStatuses`, and
`setSteerOperationRecord`, plus the queue and steer callers in
`session-dispatch-watcher.ts` and `session-execution-service.ts`.

**Interleaving:**

1. Replica A and replica B read the same session metadata containing ledger
   value `L`.
2. A adds queue receipt `q` and calls `upsertDocMeta({queuePromotionLedger: Lq})`.
3. B adds a steer operation/status to its stale copy and calls
   `upsertDocMeta({steerOperationLedger: Ls})` or a stale full status map.
4. `loro-repo` merges metadata fields at the top level. Each nested ledger is
   one JSON value, so the later value replaces the earlier complete ledger; it
   does not merge individual operation keys.

The queue receipt or steer recovery record can disappear. A restart then lacks
the evidence that history, activation, or provider delivery already crossed a
boundary; the queue may be replayed or held, and steer recovery may lose its
terminal outcome. The queue rewrite lease and the steer status queue do not form
one shared lock, so they do not prevent this cross-family interleaving.

**Required fence:** persist each operation as its own metadata key, use a
versioned compare-and-swap/merge-aware metadata update, or move the durable
ledger into the selected history backend with atomic per-operation updates. A
top-level patch API alone is insufficient while the ledger remains one nested
JSON value.

### F5 — Stop can still submit a steer while its durable `submitted` state is being written

**Status:** fixed in the working tree, pending commit/CI; the asynchronous
backend write introduced by the transition widens the window; user-visible.

**Code path:**

- `apps/cli/src/session/session-execution-service.ts` steer path around
  `rejectBeforeProviderSubmission`, `updateSteerTurnStatus`, and
  `agentClient.steerPrompt`;
- the same file's `cancelSession` and `runtime.steerWaitController`.

**Interleaving:**

1. The steer passes the last `rejectBeforeProviderSubmission` check: the runtime
   is still the current turn, no Stop has arrived, and the prompt still accepts
   input.
2. Before calling the provider, the code awaits
   `updateSteerTurnStatus(... phase: 'submitted', delivery: 'unknown')`. This
   operation queues and awaits the backend's durable read/write; it is not
   wrapped in `wait(...)`, so `steerWaitController.abort()` cannot interrupt
   this particular await.
3. While the backend write is paused, the user clicks Stop. `cancelSession`
   sets `runtime.cancelRequested = true`, records the cancellation policy, and
   aborts the steer wait controller.
4. The durable write resumes. The code does not re-check cancellation or runtime
   identity, sets `providerSubmissionStarted`, and calls
   `agentClient.steerPrompt`.
5. The provider can send or apply the steer even though Stop has returned
   successfully. This is especially visible with
   `pendingInputOnCancel = 'preserve'`, where the user's expectation is that the
   input remains undelivered.

**Why this is a transition finding:** the old path did not place an asynchronous
history/backend write in this provider-submission window. With Roost registered,
the await is a real remote or durable boundary. Post-submission status handling
cannot retract a steer that has already reached the provider.

**Required fence:** immediately after the durable `submitted` write and before
the provider call, re-check the same runtime identity, turn identity, and
cancellation state. A stronger design can make submission ownership and Stop
resolution one per-session ownership fence. Relying on the abort signal alone is
insufficient because this status write does not use the aborted `wait` wrapper.
The current implementation adds this immediate post-write check. A deterministic
test pauses that write, issues Stop, and verifies that the provider receives no
steer while the operation settles as `settled/not_applied/pending`.

### F6 — A CLI cold start can permanently bind an unconfirmed backend as Loro

**Status:** open; introduced by the backend transition and immutable binding;
user-visible when a Roost session is opened cold.

**Code path:**

- `apps/cli/src/lib/loro/doc.ts` `getOrCreateSessionDoc`,
  `SessionDocument.init`, and `resolveHistoryBackend`;
- `apps/cli/src/session/session-backend.ts` `createSessionBackend`;
- CLI session-document open paths that do not pass `historyBackend` explicitly.

The renderer's `createSessionStore` already has eager-sync/bootstrap handling,
so this finding does not repeat that covered renderer path; F6 is about the CLI
opening a document before catalog metadata is authoritative.
In particular, `session.chat`'s `sendSessionChatResult` calls only
`syncDocForRead` before opening the document, and its
`resolveWorkspaceForSessionOrThrow` call does not guarantee metadata sync; the
one-shot manager also continues in degraded mode when initial metadata sync
times out.

**Interleaving:**

1. The CLI cold-opens a session with no locally cached metadata and calls
   `getOrCreateSessionDoc(sessionId)` without a backend kind.
2. `repo.getDocMeta` returns no row or a stale row. `resolveHistoryBackend`
   interprets “not synchronized yet” as legacy Loro; `SessionDocument.init`
   composes the Loro history and binds `createSessionBackend` to Loro.
3. The remote catalog metadata arrives and declares
   `historyBackend: 'roost'` for this new session.
4. A later call that passes metadata to `createSessionBackend` fails with the
   `loro -> roost` identity-changed error. An older entry point that does not
   pass metadata continues to read or write Loro history.

The Roost session can therefore fail to open, show empty or stale history, write
new data to the wrong backend, or fail during dispatch/history operations. This
is not the legacy default for an old session; it is an irreversible Loro binding
made before the backend discriminator was authoritative.

**Required fence:** do not create a history store/backend until catalog metadata,
the creation response, or an equivalent bootstrap has confirmed the discriminator.
The CLI cold-open path should wait for metadata synchronization; a timeout should
surface a retryable open failure. Once bound, metadata must not silently change
the backend, and every entry point must pass and validate the same confirmed
identity.

## Explicitly excluded from the confirmed list

These were inspected but do not currently have a complete, user-visible wrong
result trace, so they must not be reported as findings without new evidence:

- activation-pointer read/write timing around `prepared-session-input.ts`;
- queue-promotion activation-pointer ordering when the existing lease and
  history subscription are present;
- `readHistoryCount()` versus `readHistoryDirectory()` disagreement;
- the bounded `TurnHistoryGate` timeout, which is an existing explicit fallback
  unless a new trace shows a changed incorrect result;
- the possible active-turn snapshot window in `reconcileSteerHistory`. No
  deterministic, user-visible wrong result can currently be produced by delaying
  one boundary, so it remains excluded;
- generic performance or long-conversation concerns;
- any claim that the Roost implementation is incomplete merely because this
  branch contains only the adapter port and registration boundary.

## Review procedure for future changes

For each new commit or adapter revision:

1. Record the new `HEAD`, comparison base, changed files, and whether the
   workspace is clean.
2. Trace one operation at a time from request acceptance to durable history or
   metadata commit. Mark every `await`, timer, observer callback, queue, and
   process lifecycle event.
3. Check identity propagation: session ID, backend kind, operation ID, user-turn
   ID, assistant-turn ID, and provider request ID. An ID omitted at a cleanup or
   retry boundary is a finding candidate.
4. Construct the shortest interleaving. Delay only one asynchronous boundary at
   a time and state which write becomes visible first.
5. Compare with `origin/main` (or the declared base) and classify the result as
   introduced, widened, pre-existing unchanged, or fixed by the change.
6. Record only confirmed findings. Move a finding to **closed** only after the
   exact fence and a deterministic regression check are present.
7. Run the repository documentation checks and report unavailable local tools or
   unrun tests separately from code conclusions.

## Current verification limits

The branch's CI was reported green. `git diff --check origin/main...HEAD` passes,
and the branch matches its remote. The local Vitest run of
`apps/cli/tests/session-execution-service.test.ts` passed all 147 tests,
including the new F5 interleaving test. The checkout has no usable `pnpm` or
`corepack`, so the full workspace checks were not run; F1–F4 and F6 remain open.

## Update log

- 2026-10-02: created from the transition review at
  `47ff40c76edaa2bb9e654b19cfde3be2b78e0c53`; recorded F1–F4 and the explicit
  exclusions above. No code, commit, or remote branch was changed by this
  review.
- 2026-10-02: continued the review at the same baseline and confirmed F5
  (Stop/steer submission) and F6 (CLI cold-start backend identity), while adding
  the `reconcileSteerHistory` exclusion. No implementation code, commit, or
  remote branch was changed; only these two review documents are new workspace
  files.
- 2026-10-02: fixed F5 by adding a runtime/turn/cancellation fence after the
  durable `submitted` write and before the provider call, with a deterministic
  paused-write/Stop regression test. The CLI execution-service suite passed
  147/147 tests; the change is not committed or pushed.
- 2026-10-02: tightened the F5 fence to include the captured `activePromptRun`
  identity and made the successful final check synchronous, so no extra
  suspension point exists between the fence and `steerPrompt`. The same
  147-test suite, formatter, and CLI type check still pass.
