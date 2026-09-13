# Acknowledged steers settle when their target turn stops

Status: implemented
Translation: current

[中文](2026-09-13-steer-settles-with-stopped-turn.zh.md)

## Abstract

A steer aimed at a running turn could stay in `pending_apply` forever: the service waited for the
agent's application verdict with no bound tied to the turn, and a runtime that holds the steer
request unanswered only settles that verdict when the connection closes. Stopping the target turn
now ends the wait — the steer response resolves with `stale-turn` and the guide's history entry
settles to a terminal status (`canceled` on stop, `failed` when the turn ended without an answer)
instead of an unbounded wait that also blocked the per-session steer mutation queue. Unknown
delivery results are deliberately terminal rather than re-queued, because the provider may still
take the held request and replaying could duplicate it. The response never waits for the held
request's verdict, but the verdict refines the outcome once it arrives: an agent-issued refusal
proves non-delivery and returns the guide to ordinary dispatch, and a late acceptance releases its
application lease so the agent client's session-update barrier cannot wedge.

## Problem and responsibilities

`steerSessionLocked` awaited `steerRun.applied` unconditionally. For request-transport runtimes the
verdict settles only when the agent answers the extension request or the connection closes — the
steer prompt itself is not aborted with the turn — so after a Stop the await hung, the response
never resolved, and the guide stayed in `pending_apply` while ordinary dispatch deliberately skips
that status (the stranded state in issue #666). For prompt-transport runtimes the stopped prompt
rejects `applied` directly, which fell into the generic `error` disposition that also left the entry
untouched.

- `steerSessionLocked` races `steerRun.applied` against the target turn's prompt-run settlement. The
  prompt run is the cancellation owner, so its settlement is the structural bound; no arbitrary
  timeout is introduced.
- When settlement wins the race, the guide is settled with `setTerminalUserTurnStatus` and the
  response is `stale-turn`. The same settlement is applied in the catch path when a post-submission
  stop rejects the verdict, so both transports converge.
- Confirmed refusals (`AgentSteerNotDeliveredError`) and pre-submission rejections keep their
  existing requeue-to-dispatch behavior unchanged; the terminal path only covers the unknown
  post-submission window.
- The application waiter stays registered in the agent client until the agent answers or the
  connection closes, so the race result cannot resurrect the stopped turn. After settlement the
  service still consumes the pending verdict without awaiting it: a late acceptance is released
  immediately (the agent client installs `waiter.released` as the session's application barrier and
  blocks every later `sessionUpdate` until the lease is released), and a late
  `AgentSteerNotDeliveredError` — produced only by the agent's own invalid-request answer — requeues
  the guide via `requeueSteerAfterLateRefusal`, which flips back only the terminal status that same
  race branch wrote and re-walks the ordinary requeue guards; the existing post-application
  cancellation guard is unchanged. The requeue also covers the entry that has not synced to this
  daemon (the supported RPC-before-history ordering): it requeues through the pointer alone and
  drops the race branch's terminal-without-entry record so the late-syncing entry dispatches via
  the `pending_apply` pointer match instead of being repaired back to terminal, and it never
  replaces a newer activation that owns the dispatch pointer — execution writes its own slots only
  — leaving the flipped entry to the dispatch scan that the newer activation keeps running.

## Trade-offs and compatibility

- Terminal-instead-of-requeue is the load-bearing choice: an auto-replay after an unknown verdict
  risks duplicate delivery, which the report rules out explicitly. The terminal status therefore
  covers only the genuinely unknown window; when the agent later proves it never applied, the guide
  is requeued automatically, and a user needs to re-send only when the verdict stays unknown (for
  example the connection closes without an answer).
- Marking a non-cancel settlement `failed` is the one heuristic: an agent that finishes a turn
  without answering a held steer request is outside the acknowledged-steer contract, and the failure
  status reflects the unanswered verdict rather than asserting delivery.
- The steer mutation queue is unblocked as soon as the response settles; queue ordering for later
  steers is unchanged.
- The dispatch pointer is single-slot and producer-owned. When a newer send published its
  activation while the steer request was held, the requeue must not reclaim the slot: it leaves
  the pointer alone and relies on the chronological scan that the live activation keeps running (a
  not-yet-synced entry then keeps steer intent, which dispatches only through an explicit pointer
  match). Destroying the newer activation would strand that turn permanently once the watcher
  unloads.

## Verification

Two regression tests reproduce the report: a held verdict plus a stopped turn resolves `stale-turn`
and writes the `canceled` status (previously the test timed out at 30s), and a rejected verdict on a
stopped turn converges to the same settlement (previously `error` with no history write). Two more
cover the late verdict: a refused-after-settlement guide returns to `pending` with the dispatch
pointer rewritten, and a late acceptance releases its lease. All four fail before the refinement and
pass with it; the full `apps/cli` suite passes unchanged apart from two runtime mocks completed with
the `promptOutcome` field the race now reads.

Five further tests cover the requeue edges flagged in review: an entry absent at refusal time is
requeued through the pointer and the stale terminal-without-entry record is cleared (previously the
guide stranded); with a live newer activation owning the pointer, an absent entry gets no pointer
write (the record is still cleared) and a present entry is flipped to `pending` without a pointer
rewrite (previously the newer turn's activation was clobbered); a pointer naming an already-handled
turn and a pointer retired by `settledActivationUserMsgId` are both treated as free slots, so the
requeue still publishes. The first three fail on the previous head.
