# Stop pauses result wakes, not Agent chat

Status: implemented
Translation: current

[中文](2026-10-18-stop-pause-admits-agent-chat.zh.md)

## Abstract

An Inbox-aware Stop paused the Session until a human sent a trusted message, and
the pause also rejected every non-human input. Agent chat sent from an orchestrating
Session therefore sat silently undelivered until the user happened to type
something, so it looked as if the dispatch had been lost. Stop now pauses only
automatic Operation-completion wakes. Fresh input from a human or from another
Session's Agent chat is admitted at the same rank and clears the pause. The trade-off
is that an Agent can now resume a Session the user stopped; the conversation-tree stop
remains the hard barrier against agent loops.

## Evidence

The incident in the daemon logs: an Operation target was stopped at
2026-10-17 13:02:58 (`Session stop requested`, turn outcome `cancelled`). The next
day, two `lody_session_chat` inputs were dispatched six times between 02:02:17 and
02:03:01. Every attempt ended with `execution.visible_turn … outcome=inbox-paused`.
A human "did you receive it?" at 02:04:49 cleared the pause, and the backlog ran
two seconds later, in admission order rather than send order.

Cause: `inputAcceptance` in `apps/cli/src/orchestration/inbox/rules.ts` returned
`reject` for `kind === 'task' && paused`. A `task` is any input without a matching
human receipt, which includes every Agent chat. Only `human` acceptance cleared
`paused` in `sqlite.ts`.

## Decision

- Admission no longer depends on `paused`. Any fresh non-automatic input is
  accepted unless Stop already canceled it as pre-Stop queued input. Acceptance
  clears `paused` for both kinds, and the service-level veto left by a failed pause
  write is cleared by either kind.
- Pre-Stop queued input stays canceled: Stop still records it as canceled, and a
  resend is required.
- Receipts still decide only whether an input is recorded as `human`, which the
  Inbox uses for human-input preference. They no longer gate execution after Stop.
- Operator recovery uses the same pause flag. Fresh Agent chat now resumes a
  Session after operator recovery as well; the recovery still never replays the
  retired execution.

## Alternatives

- Admit Agent chat but keep the pause. Rejected: Operations delegated from that
  turn could never wake the Session, which breaks orchestration in a new way.
- Report `paused` back to the sender while keeping the rule. Rejected by the owner:
  Agent chat is an explicit instruction and should rank with human input.

## Verification

- `apps/cli/src/orchestration/inbox/inbox.test.ts`: fresh human and `task` input
  each clear the pause and carry saved results. Pre-Stop queued input stays
  rejected, including another requester's.
- `apps/cli/tests/session-execution-service.test.ts`: after an Inbox-aware Stop,
  an Agent chat turn runs through the real prompt boundary and clears the pause.
  The receipt-recovery test now expects post-Stop input without a matching receipt
  to run as `task`.
- `operation-model.ts` models fresh input as a single `human` event, which already
  matches the new rule; no trace changed.
- Not verified end-to-end with two live Sessions.
