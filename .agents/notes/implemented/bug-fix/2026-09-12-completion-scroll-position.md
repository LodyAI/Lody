# Preserve the reader during Turn completion

Status: implemented
Translation: pending

## Abstract

Finishing an assistant Turn changes the conversation from its streaming row layout to the
collapsed `Worked for …` layout while also retiring the activity row. When bottom-follow has
already been released, either contraction can remove enough virtual height to clamp the viewport
to the new end and discard the reader's position. Completion still folds immediately; the
conversation now preserves a stable visible row's viewport coordinate across that layout commit.

## Decision

The follow lock is mirrored synchronously from `useStickyScroll` into the conversation renderer.
This is necessary because upward-wheel intent and completion can arrive before an effect reports
the changed lock. When either the latest Turn folds or its activity row retires while follow is
released, render captures the nearest mounted row whose key survives the new virtual layout and
records its offset from the viewport top.

The same commit renders the ordinary finished rows and a provisional trailing spacer. The spacer
temporarily preserves at least the old scroll range, preventing the browser and sticky-scroll
tolerance from clamping or re-locking before React layout effects run. The layout effect measures
the surviving anchor again, scrolls by the coordinate delta, and reduces the spacer to only the
height needed to keep that compensated offset outside the library's follow tolerance. A bounded
four-frame correction follows Virtua's asynchronous row measurements; real reader input cancels
that correction. Reaching the bottom or choosing “scroll to latest” removes the spacer. No finished
message is represented as structurally streaming.

## Alternatives

- Restoring the old numeric `scrollTop` ignores height removed before the reader's content, so it
  does not preserve the content's screen coordinate.
- Applying only an anchor delta after contraction is too late when the new scroll range has already
  clamped the viewport; the provisional spacer prevents that destructive intermediate state.
- Suppressing every completion auto-scroll would also detach readers who intentionally remained at
  the bottom.
- Deferring `Worked for …` folding preserves height but changes the completion UX. Folding remains
  immediate and only scroll geometry receives transient state.

## Evidence and limits

`tests/chat-virtual-rows-identity.test.ts` verifies that an interleaved tool/text Turn folds
immediately at completion. `tests/completion-visual-anchor.test.ts` covers both completion event
orders, stable-row selection, anchor-delta geometry, and the trailing follow-release guard.
`tests/use-sticky-scroll.test.ts` verifies that programmatic suppression updates the synchronous
follow mirror, upward wheel intent reaches it before React reports the new lock, and a suppressed
content contraction overrides the dependency's near-bottom re-lock.

The existing streaming Playwright story does not transition its message to `finished` or its live
status to idle; it stops at an `indicator-only` phase. A browser-level completion transition remains
useful future coverage, particularly for touch and scrollbar-drag release paths.
