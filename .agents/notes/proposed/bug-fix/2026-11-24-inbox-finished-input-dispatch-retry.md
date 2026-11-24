# Dispatcher retries finished Inbox inputs after interrupt (#2994)

Status: proposed
Translation: missing
Issue: [#2994](https://github.com/LodyAI/Lody/issues/2994)

[中文](2026-11-24-inbox-finished-input-dispatch-retry.zh.md)

## Abstract

After a process interrupt, `InboxSqlite.activate()` retires the in-flight input (`finished=1`, `sqlite.ts:393`) but the session metadata claim `processingUserMsgId` survives in Loro meta. The dispatch selector `findNextDispatchableUserTurn` re-selects that turn on every cycle through Path 3 (`session-dispatch-logic.ts:366`), which has no `finished`/`inputEnded` guard. Each selection ends in `InboxExecutionRejected` at `execution-owner.ts:31`; the intended one-shot settle (`session-execution-service.ts:5150-5183`) clears the claim only through `upsertSessionMeta`, which silently no-ops when `repo.upsertDocMeta` is absent (`session-execution-service.ts:6249-6254`) and can lose to a Loro flush on exit. When the clear never lands, the same finished input is dispatched on every cycle indefinitely.

## Reproduction

`locate-2994.repro.test.ts` (committed at
`.agents/notes/proposed/bug-fix/assets/locate-2994/locate-2994.repro.test.ts`;
drop it into `apps/cli/tests/` to run — it asserts the *current* buggy
behaviour, so it must not ship in the suite)
runs against the real `InboxSqlite` and `findNextDispatchableUserTurn`. It
accepts + begins an input, reopens the store under a new owner (`activate` →
`finished=1`), then shows (a) the input is terminally ended yet Path 3 still
returns it while `processingUserMsgId` is set, and (b) five consecutive
dispatch cycles all re-select the same finished input and all five `begin`
calls reject — the reported retry loop — when the claim is not cleared.
Run: `cp .agents/notes/proposed/bug-fix/assets/locate-2994/locate-2994.repro.test.ts apps/cli/tests/ && cd apps/cli && vitest run tests/locate-2994.repro.test.ts` — 3/3 pass.

## Root cause

The loop lives at the junction of three state machines that each trust a
different source of truth:

1. **Interrupt → finished.** `InboxSqlite.activate`
   (`apps/cli/src/orchestration/inbox/sqlite.ts:351-421`) sweeps stale
   `active_execution`/`active_input` and writes `finished=1` on the
   interrupted input (line 393). `begin` then refuses it permanently
   (`inputEnded`, line 554; admission check in `begin`/`prepare`).

2. **Selection does not check finished.**
   `findNextDispatchableUserTurn`
   (`apps/cli/src/session/session-dispatch-logic.ts:306-377`) picks a turn
   purely from history status and meta pointers. Path 3 (line 366-368) returns
   any turn whose `id === meta.processingUserMsgId`; Path 4 (line 370-373)
   returns `latestUserMsgId !== lastHandledUserMsgId`. Neither consults
   `inbox_inputs.finished` nor `inputEnded`. The only durable-state guard in
   the watcher is `isInboxInputCanceled`
   (`session-dispatch-watcher.ts:3378, 3492`) — there is no finished-input twin.

3. **The settle that ends the loop is meta-write-dependent.**
   `continueSession` → `openExecution` → `makeExecutionOwner` →
   `inbox.begin(input, id)` returns `false` →
   `InboxExecutionRejected` (`execution-owner.ts:31`). The catch block at
   `session-execution-service.ts:5126-5184` sees `inputEnded` and calls
   `continueInterruptedTurn` (same machine + claim →
   `markDispatchCancelled`, line 6762-6779) or `retireEndedInboxInputTurn`
   (claim already gone → `markTurnFailed`, line 6842-6853). **Both** converge
   on `upsertSessionMeta(sessionId, { processingUserMsgId: undefined, … })`
   (line 6245-6256). That helper returns silently when
   `workspaceDocument.repo.upsertDocMeta` is undefined — an optional
   dependency — and its write rides the Loro doc flush, which a following
   interrupt can discard. Nothing verifies the write landed.

When the claim survives a settle attempt (missing `upsertDocMeta`, flush loss,
or a peer that owns the doc read-only), the next dispatch cycle starts at step 2
again — and the `maybeRepairAlreadyHandledTurn` guard that would otherwise
stamp the turn terminal **explicitly refuses to repair a turn that still holds
`processingUserMsgId`** (`session-dispatch-watcher.ts:3481-3483`), closing
the loop instead of breaking it.

A second, narrower variant: `retireEndedInboxInputTurn` → `markTurnFailed`
stamps `status='failed'` via `setUserTurnStatus`; if the history entry is
absent at that moment (late sync after RPC fast-path execution), the status
lands in the memory-only `terminalTurnStatusWithoutEntry` map
(`session-execution-service.ts:6285-6304`), lost on restart. The repair
backstop at `session-dispatch-watcher.ts:3506` then needs
`meta.lastHandledUserMsgId === turn.id` — again a meta write — so a lost meta
write leaves both the status and the claim unsettled.

## Minimal-fix direction

The defect is a **selection/admission asymmetry**: `finished` is consulted at
admission (`begin`, `prepare`) but not at selection. The smallest correct
fix is to teach selection the same durable terminal states admission knows —
i.e. treat a turn whose Inbox input `inputEnded` (finished **or** canceled)
as non-dispatchable — rather than adding another post-hoc repair:

- In the watcher's candidate scan
  (`session-dispatch-watcher.ts:3355-3391`), extend the existing
  `isInboxInputCanceled` repair to also cover
  `executionService.inputEnded`-equivalent (finished-but-not-canceled): stamp
  the user turn terminal (`'failed'` with the existing ended-input notice
  text rather than `'canceled'`) and clear `processingUserMsgId` when it
  points at the turn — the branch already exists verbatim at
  `settleTerminalActivation` (`session-dispatch-watcher.ts:2873-2887`).

- Alternatively/al additionally, add an `inputEnded` check to
  `maybeRepairAlreadyHandledTurn` (`session-dispatch-watcher.ts:3474`) —
  but note the `processingUserMsgId === turn.id` early-return at line 3481
  currently skips that whole function for exactly the turns that need it;
  the check must run **before** that guard or the claim must be cleared there.

- Do **not** fix by retrying `upsertSessionMeta` harder: the write is already
  the mechanism and adding retries does not cover the absent-method no-op.
  Making `upsertSessionMeta` report failure (throw or log) is still worth
  doing — a silent no-op on the only claim-clearing path is what converted a
  one-shot recovery into an infinite retry — but it is a diagnostic fix, not
  the semantic one.

## Evidence and limits

- Repro: `vitest run tests/locate-2994.repro.test.ts` (3/3 pass in `apps/cli`, real
  `InboxSqlite` + real `findNextDispatchableUserTurn`, no mocks on the
  paths under test).
- The infinite variant (meta-write never lands) is shown by construction: the
  selection has no finished guard, so any mechanism that keeps
  `processingUserMsgId` set repeats the cycle. The `upsertDocMeta ===
  undefined` silent return at `session-execution-service.ts:6249-6254` is a
  concrete such mechanism; a lost Loro flush before exit is a second.
- Not proven here: the specific field condition that produced #2994's report
  (absent `upsertDocMeta` vs. lost flush vs. peer-owned doc). All three land
  on the same branch; the fix above covers all three.
- Scope: human inputs (`kind='human'`, `'task'`, `'automation'`).
  `kind='automatic'` inputs bypass `inbox_inputs` entirely and are out of
  scope for this issue's wording.
