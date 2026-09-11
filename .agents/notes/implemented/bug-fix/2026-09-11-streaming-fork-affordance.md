# Keep Fork affordances completion-gated

Status: implemented
Translation: pending

## Abstract

Streaming assistant replies exposed a Fork icon because partial context copying
reused the finished-turn fork menu. Native forking was still disabled, but the
shared affordance falsely suggested that an unfinished reply could be forked and
allowed pending-fork presentation to outlive the completion boundary. Streaming
replies now keep context copying through a direct Copy action, while Fork and its
loading state render only for finished replies.

## Decision

The context-copy capability and native-fork lifecycle are separate presentation
states. Partial replies remain exportable as required by the
[conversation context copy Spec](../../../../specs/conversation-context-copy-and-text-attachments.md),
but they do not render `AssistantForkButton`. A pending fork keeps the finished
turn action group visible after pointer exit; if that turn reopens, its Fork
spinner is hidden until the message is finished again.

This corrects the shared-menu decision recorded in
[Conversation context fallback](../feature/2026-09-09-conversation-context-fallback.md)
without removing point-in-time streaming exports or changing native fork
capability checks.

## Verification

The existing fork destination suite now covers both sides of the boundary. Its
streaming fixture deliberately carries a matching pending-fork id and verifies a
direct context-copy action, no Fork control, and no forced persistent action row.
The finished fixture verifies that context copy remains available from the Fork
menu, while the assistant footer suite retains coverage for a visible pending
Fork group on a completed turn.
