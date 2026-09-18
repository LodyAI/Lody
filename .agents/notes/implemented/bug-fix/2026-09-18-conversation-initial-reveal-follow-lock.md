# Initial conversation reveal is not the follow lock

Status: implemented
Translation: current

[中文](2026-09-18-conversation-initial-reveal-follow-lock.zh.md)

## Abstract

Opening a Chat Session could leave the conversation pane permanently black while
the message DOM was fully present. The viewport stays `visibility: hidden` until
`initialScrollRestored`, and that flag never flipped: the ready check used the
scroll library's ~70px near-bottom lock as "following" and required the last
row's box to sit within 2px of the viewport bottom, while the follow-lock fix
for group toggles stopped observers from correcting to the real bottom until a
commit snapshot said the reader was already following. First end-restore is now
one-time positioning, not follow-lock. The ready check uses restore intent and
viewport distance from the DOM bottom. After reveal, observers still must not
re-arm follow.

## Root cause

`SessionChatStreamView` hides `[data-message-selection-scroll]` until
`initialWindowReady && initialScrollRestored`. `settleInitialLayout` called
`isInitialScrollLayoutReady(..., state.isAtBottom)`. `state.isAtBottom` is the
library follow lock and includes ~70px of near-bottom tolerance, but the ready
function treated it as "flush with the last row" and compared
`getBoundingClientRect` of that row to `clientHeight - paddingBottom` within
2px. A scroller that is itself `visibility: hidden` with `contain: strict` can
make descendant boxes a bad flush signal; a restore that lands inside the 70px
band also fails the 2px test.

Independently, [worked-group follow-lock](2026-09-17-worked-group-toggle-scroll-jump.md)
made geometry observers call `stopScroll()` and skip `scrollToRealBottom()` when
`wasFollowingRef` was false. That is the right rule after reveal. During the
first end-restore it undoes the one-time positioning the 2px check still needed,
and hooks rules forbid a settle timer, so the pane stayed hidden.

The visibility gate itself stays. Ablation in
[windowed conversation reads](../architecture/2026-09-10-windowed-reader-integration.md)
showed that removing it exposes an empty or uncorrected window on a cold
virtualizer.

## Contract

- Until `initialScrollRestored`, an end restore (cached position is not
  `offset`) may keep writing the real DOM bottom from observer and layout
  paths while the lock has never been held (`hadFollowedRef` is false) or
  the commit snapshot is still following. A reader who already followed and
  then escaped is not pulled back, even while the viewport is hidden.
  `stopScroll()` from geometry observers is suppressed until reveal.
- Ready uses restore intent, not `state.isAtBottom`. Offset restores never
  take the flush-to-bottom branch. End restores require
  `getScrollElementDistanceFromBottom <= 2` and a mounted destination row
  that is not Virtua-unmeasured (`style.visibility === 'hidden'`).
- Visible-bottom item lookup subtracts both viewport paddings (or equivalent
  Virtua item-offset space). The scroller's `padding-top` includes
  `--conversation-top-inset`.
- After reveal, the group-toggle contract is unchanged: observers must not
  re-arm follow; only scroll events and explicit `scrollToBottom` may.

## Alternatives

A timeout or animation-frame retry to force `visible` was rejected: scrolling
invariants forbid settle timers, and it would only delay the same flash the
gate exists to hide.

Removing `visibility: hidden` was rejected by the windowed-reader ablation.

Using `opacity: 0` instead of `visibility` was rejected: the same stuck
predicate would still never flip, and the subtree would remain in the
accessibility tree.

Reverting the group-toggle follow-lock fix was rejected: expanding a finished
"Worked for …" header would again yank a reader to the session end.

## Evidence and verification

`packages/components/tests/use-sticky-scroll.test.ts` covers the ready
function (end restore with a last-row box 50px off still reveals when
`scrollTop` is at the DOM bottom; near-bottom offset restore reveals without
a 2px flush; unmeasured destination stays hidden; visible-bottom lookup
subtracts top and bottom padding) and the hook (same two restore cases).
`packages/components/tests/sticky-scroll-virtua.test.tsx` still asserts that
a collapse shrink cannot re-arm follow for an escaped reader after reveal,
and that a following reader stays at the end.

No timer was added. Device-scale cold-open flash remains the capture in
`e2e/scripts/capture-conversation-open-flicker.mjs`; this change does not
re-measure it.

## Trade-offs and limits

An end restore can still sit hidden while the last row is unmeasured, which
is the original empty-window protection. If Virtua's `scrollOffset` and the
DOM `scrollTop` disagree by more than 1px, reveal still waits. A reader who
restored to an offset inside the library's near-bottom band is shown at that
offset rather than flushed to the end; they can scroll to re-lock follow.
