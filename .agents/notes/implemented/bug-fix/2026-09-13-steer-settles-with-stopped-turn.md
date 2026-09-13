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
take the held request and replaying could duplicate it.

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
  connection closes, so a late verdict resolves into a promise nobody consumes and cannot resurrect
  the stopped turn; the existing post-application cancellation guard is unchanged.

## Trade-offs and compatibility

- Terminal-instead-of-requeue is the load-bearing choice: an auto-replay after an unknown verdict
  risks duplicate delivery, which the report rules out explicitly. The cost is that a user must
  re-send the guide manually when a provider later proves it never applied; the entry's terminal
  status makes that visible.
- Marking a non-cancel settlement `failed` is the one heuristic: an agent that finishes a turn
  without answering a held steer request is outside the acknowledged-steer contract, and the failure
  status reflects the unanswered verdict rather than asserting delivery.
- The steer mutation queue is unblocked as soon as the response settles; queue ordering for later
  steers is unchanged.

## Verification

Two regression tests reproduce the report: a held verdict plus a stopped turn resolves `stale-turn`
and writes the `canceled` status (previously the test timed out at 30s), and a rejected verdict on a
stopped turn converges to the same settlement (previously `error` with no history write). Both fail
on the parent commit and pass with the fix; the full `apps/cli` suite passes unchanged apart from two
runtime mocks completed with the `promptOutcome` field the race now reads.
