# Conversation outline rail waits for ten user rounds

Status: implemented
Translation: current

[中文](2026-09-19-conversation-outline-minimum-rounds.zh.md)

## Abstract

The conversation outline rail — the left table of contents with one tick per
round — was mounted for every desktop conversation with at least two rounds,
so a short session showed a handful of ticks that decorated rather than
navigated. The rail now mounts only once a conversation reaches
`OUTLINE_MIN_USER_ROUNDS` (10) user-driven rounds. The gate lives at the
`SessionChatStreamView` mount site, not inside `ConversationOutlineRail`, so
the component stays usable standalone (stories, previews) with only its
degenerate `< 2` tick guard.

## Decision

The threshold counts USER-driven rounds via `countUserDrivenRounds` in
`lib/conversation-outline.ts`: an agent-initiated leading round (a scheduled
run or fork, marked `startsWithAgent`) is not a turn the user drove and does
not count. At most one such entry can exist, so the distinction matters only
for agent-started sessions.

Gating at the view rather than the component keeps the rail presentational —
its own `< 2` early return remains a degenerate-case guard, and Storybook
stories with few entries still render. Not mounting also means the rail's
effects (arrival-intent pointer listeners, ResizeObserver) never install for a
short conversation. Outline entries and anchors are still computed so the
active-index state is warm when the rail first appears.

## Verification

`packages/components/tests/conversation-outline.test.ts` covers
`countUserDrivenRounds`: plain counting, the leading-agent-round exclusion at
the exact boundary, and the empty outline. The `ShortStreamHidesRail` story
documents the hidden state inside the real `SessionChatStreamView` (four
rounds mount no rail), while `InsideTheConversationStream` at fourteen rounds
still shows it.
