# Worked-group toggles no longer move the reader

Status: implemented
Translation: current

[中文](2026-09-17-worked-group-toggle-scroll-jump.zh.md)

## Abstract

Clicking a finished turn's "Worked for …" header while reading above the bottom
of a Chat Session unexpectedly yanked the view to the session end. Two
mechanisms compounded: expansion issued a programmatic scroll-to-row that the
virtualizer clamped at the maximum offset near the end of the list, and the
scroll-following library re-engaged its follow lock whenever a geometry change
landed the viewport inside its near-bottom tolerance — even for a reader who had
deliberately scrolled away. Toggling now never scrolls, and observer deliveries
can no longer re-arm the follow lock: only real scroll events may. A reader
following the tail still stays pinned to it across a toggle.

## Root cause

`SessionChatStreamView` expansion scheduled `scrollRowToTop` on the expanded
header. For a header near the end of the list, `scrollToIndex(align: 'start')`
clamps at the maximum scroll offset, producing a large downward programmatic
scroll. `use-stick-to-bottom` cannot distinguish that from user scrolling: the
downward direction clears `escapedFromLock`, landing within its ~70px
near-bottom tolerance re-arms `state.isAtBottom`, and the follow path then pins
the view to the bottom on every subsequent geometry change.

Independently, the library's own content ResizeObserver re-locks
`state.isAtBottom` on any net-negative resize delivered while the viewport is
within the near-bottom tolerance (`difference < 0 && isNearBottom`). Virtualizer
spacer churn or a collapse can deliver such a shrink; once re-locked, the
library's queued `scrollToBottom` animation tick and this hook's own `follow()`
both write `scrollTop` — so suppression armed only for the commit could not
prevent the slide, and a commit-time lock snapshot alone was overwritten by the
re-lock's state-flush commit before pending deliveries ran.

## Contract

- Toggling a worked group or activity group never scrolls. The header stays at
  the pixel the reader clicked and rows open or fold beneath it.
- The follow lock (`state.isAtBottom`) is armed only by scroll events and the
  explicit `scrollToBottom`; observer deliveries must never re-arm it. The
  hook snapshots the lock per commit (`wasFollowingRef`, forced false while a
  programmatic jump suppresses follow) and gates its `follow()` scrolls on it.
  Its content ResizeObserver callback runs after the library's in the same
  delivery and releases any same-delivery re-lock while that snapshot says
  not-following, so a queued animation tick finds the lock already open.
- `scrollRowToTop` remains the only row-index-to-scroll conversion, now used by
  outline jumps, search, and imperative scrolling only.

## Evidence and verification

Reproduction preserved as the Storybook story
`Sessions/ConversationView → WorkedGroupExpandJump` (deterministic synthetic
history; no captured transcripts). With agent-browser driving real clicks:

- ~400px above bottom: expand and collapse leave `scrollTop` exactly unchanged.
- ~50px above bottom (inside the library's near-bottom tolerance): same.
- At bottom: the view stays at the bottom — follow intent is preserved.
- 3000-turn virtualized story: a visible header stays at the same viewport
  offset through expand and collapse.

`tests/sticky-scroll-virtua.test.tsx` mounts a real `Virtualizer` with the hook
and mocked observers: a collapse-commit shrink delivery cannot re-arm the lock
for an escaped reader (no scroll writes, position kept), while a following
reader still lands within the library's one-pixel epsilon of the end.

## Trade-offs and limits

Clicking a row that is mounted but fully above the viewport (Virtua's render
buffer) still triggers Virtua's item-size scroll compensation, which clamps at
the maximum offset — legitimate anchoring for content inserted above the scroll
position, and not reachable by pointer for a visible row. A narrow race remains:
a resize delivery landing between a user's scroll-to-bottom re-lock and its
commit can release that intent; the reader scrolls once more and re-locks. No
timers or frame retries were added, per the scrolling invariants in
`packages/components/src/hooks/AGENTS.md`.
