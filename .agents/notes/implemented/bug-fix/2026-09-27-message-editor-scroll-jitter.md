# Keep message editing from correcting the conversation to its tail

Status: implemented
Translation: current

[中文](2026-09-27-message-editor-scroll-jitter.zh.md)

## Abstract

Editing the latest user message could make a conversation visibly jump when the editor gained
lines. The editor lives inside a keyed conversation row, so each textarea resize delivered row
geometry while the scroll engine was still correcting a followed viewport to the real bottom. The
row now reports its editing state to a dedicated scroll pause ref, which prevents those corrections
without changing the follow mode or adding another scroll writer.

## Problem and decision

`UserMessageEditor` grows its textarea synchronously from `scrollHeight`. Because it is mounted in
the user-message row, each added line changes that row's measured height. The conversation scroll
engine observes that geometry and, in `follow`, corrects the viewport to the real bottom. That
correction is appropriate for streaming output but moves the viewport while a reader is editing.

`SessionChatStreamView` keeps an `editingUserMessageRef` alongside its other suppression reasons.
The connected row renderer passes a callback only to the latest editable user row; the row reports
`true` from a layout effect as editing starts and clears it when editing ends or unmounts. The
callback feeds the engine's dedicated `ScrollHost` pause path, so row measurement still commits and
the engine remains the only follow-mode scroll writer. The existing suppression path still releases
follow mode for deliberate reading-position changes.

The fix deliberately keeps the current `follow`/`read`/`sent` intent unchanged. Releasing follow
when editing begins would make later streamed output stop following after the editor closes, while
a second scroll writer would reintroduce competing corrections. Once editing ends, later geometry
changes therefore use the mode that was already active.

## Evidence and limits

- The implementation keeps the existing `ScrollController` as the only follow-mode scroll writer;
  the pause signal changes whether geometry may write a correction, not the stored intent.
- A running desktop/Web conversation has not been exercised for this PR assembly.

## Related decisions

- [Conversation follow modes](../architecture/2026-09-23-conversation-follow-modes.md) defines the
  single follow-mode owner and rejects competing scroll writers.
- [Conversation scroll](../../../../specs/conversation-scroll.md) records the user-facing editing
  guarantee as a draft until human review.
