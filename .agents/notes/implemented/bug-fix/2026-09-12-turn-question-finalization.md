# End pending questions with their owning turn

Status: implemented
Translation: current

[中文](2026-09-12-turn-question-finalization.zh.md)

## Abstract

Stopping a Pi turn cancelled its native questionnaire but left Lody's persisted
question unanswered and actionable. Turn finalization now writes a cancelled
outcome for unanswered requests in the assistant entry it already owns. Existing
history subscriptions release the ACP waiter and the renderer withdraws the card.
The change preserves answered outcomes and requests in other turns, without a
second request registry or an adapter-specific cancellation protocol.

## Ownership and scope

The adapter controls native execution; Lody owns the user interaction and its
history. `MessageHandler.finalizeACPState` already flushes updates and calls
`markAssistantTurnFinished` in a `SessionDocument.updateHistory` write. That is
the shared completion, cancellation and teardown boundary for the assistant entry.
Its existing `turnId` selects the entry, so cleanup does not infer ownership from
the currently visible question or cancel every request in the session.

Only requests without an outcome become cancelled. An already recorded answer
survives, and repeat finalization preserves the existing terminal timing. The
permission waiter's history subscription sees the same outcome used by the UI;
no extra callback collection, flag or frontend state is required.

A request can finish loading its document after Stop has finalized the tool's
entry. Permission enrichment refuses that finished owner rather than attaching
the request there or falling back to the newer turn. The existing caller returns
cancellation when enrichment reports that the request was not persisted.

This corrects an existing host integration gap exposed by Pi. It does not change
Pi's execution contract or the accepted Unix hard-crash limitation. It does not
introduce cross-device arbitration for answers authored concurrently with Stop.

## Evidence and verification

- Before the fix, the regression in `history-permission-writer.test.ts` observed
  an undefined outcome after finalizing the owning turn.
- After the fix, the real SessionDocument/HistoryWriter path persists cancellation
  and notifies the history subscriber. It preserves an answered request, a newer
  turn's pending request, existing unknown tool content and CRDT container ids.
- The same test rejects a delayed request for a tool in the finalized turn;
  before the admission check, enrichment incorrectly returned success.
- The existing terminal-timing and compaction finalization tests remain passing.
- Full Electron interaction acceptance is not established by this integration test.

This accompanies [Lody PR #605](https://github.com/LodyAI/Lody/pull/605) and
[Pi PR #1](https://github.com/LodyAI/acp-extension-pi/pull/1).
