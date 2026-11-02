# Keep access-pending Inbox inputs admissible

Status: implemented
Translation: current
PR: not created

[中文](2026-10-15-access-pending-inbox-withdraw.zh.md)

## Abstract

A brief control-plane outage during machine-access verification made a message, and every later
message in the same Session, fail to start forever with
`INBOX_EXECUTION_REJECTED: inspect blocked resources with lody session recover-inbox`. The prepared
dispatch opened its Operation Inbox execution before access resolved. When access came back
`indeterminate`, the turn stayed pending for the retry but the execution was released, and release
marks the input finished, so the retry's `begin` was rejected on every attempt. Such a turn now
withdraws its unsubmitted execution, leaving the input admissible. A pending turn whose input has
already ended is now failed with a visible notice instead of blocking the queue.

## Evidence

On 2026-10-15 three Sessions on one Machine hit `fetch failed` / `ETIMEDOUT` access checks between
16:18 and 16:27 UTC. The daemon log shows `access-indeterminate` followed by repeated
`inbox-prepare-failed` for the same user turns. A read-only query of `inbox_inputs` showed
`finished=1, canceled=0` for each affected input, with a `failed` release receipt for
`assistant:<userTurnId>`. `findNextDispatchableUserTurn` kept selecting the oldest pending turn,
so later messages queued behind it: one Session retried a single turn 19 times.

## Decision

- **Root fix: withdraw instead of release.** When access is `indeterminate`, the prepared dispatch
  marks the turn runtime. At turn end, an execution that never started a prompt and was not
  cancelled calls the new `ExecutionOwner.withdraw`. SQLite `withdraw` clears the active execution
  only if no release receipt or fenced/submitted batch exists for it; the execution owner also refuses once it holds a Session cleanup handle. It writes
  no receipt and leaves the input unfinished. The retry reuses the fixed execution ID
  `assistant:<userTurnId>`, so a receipt would have made it a conflicting release. A prepared
  human-plus-results batch keeps its claims and is reused by the retry.
- **Access still resolves inside the visible turn.** Existing contracts require the turn runtime
  to be registered while access is pending, so Stop and the active-invocation lookup work during
  verification. Inbox Stop pauses through that active execution, so deferring `begin` until after
  access would break Stop.
- **Backstop for already-broken state.** If `begin` rejects a non-batch input that SQLite reports
  as ended (`inputEnded`: finished or canceled), the turn records `turn_pre_prompt_failed` with a
  notice asking the user to resend, unless history already shows it terminal. Lody still never
  replays it. This repairs Sessions left stuck by older daemons and any future path that ends an
  input while history stays pending. Other rejection reasons, such as blocked resources, an active
  execution, or a lost Host lease, keep their existing behavior.
- The reduced race model gains a `withdraw` event: an unsubmitted human execution returns to
  pending human input, and the exhaustive exploration still proves at-most-once delivery.

## Alternatives considered

- **Await access before opening the visible turn.** Rejected: it breaks Stop and the invocation
  lookup while access is pending, which existing tests pin.
- **Release with a new non-finishing outcome.** Rejected: the release receipt is keyed by the
  fixed execution ID, so the retry's eventual release would conflict and block the Session.
- **Fail any rejected input in history** (an earlier local patch). Rejected as the only fix: it
  turns transient rejections, such as a Host-lease handoff, into permanent failures, loses the
  message on every network blip, and its history write shared the release `try`, so a write
  failure skipped runtime cleanup.

## Verification and limits

`apps/cli/tests/session-execution-service.test.ts` uses a real SQLite Inbox and Session history. An
`indeterminate` dispatch leaves the input unfinished and the turn dispatchable, and the retried
`allowed` dispatch sends the prompt exactly once. A pre-existing ended input is retired, and the
next message runs. Both tests fail without the change, with the production error.
`apps/cli/src/orchestration/inbox/inbox.test.ts` covers withdraw eligibility: it is refused after
fencing or release, and the same ID begins again after a withdraw.
`operation-model.test.ts` traces the new event.

A daemon crash while access is pending still leaves an active execution without a receipt, as
before; existing restart recovery owns that case.
