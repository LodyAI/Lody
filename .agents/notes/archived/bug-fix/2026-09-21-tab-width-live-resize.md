# Tab widths follow a live resize without easing

Status: implemented
Translation: current

[中文](2026-09-21-tab-width-live-resize.zh.md)

## Abstract

Toggling a sidebar made the desktop Session tab strip settle a beat after the
panel it lives in. `AdaptiveTabStrip` allocates integer tab widths in JavaScript
from a measured viewport width, and those widths carried the 200ms transition
that exists for Chromium's add/remove bound animation. A collapse/expand
changes the strip's flex space frame by frame, so every commit restarted a
200ms ease toward that frame's target: the tabs tracked a moving target instead
of the panel. The strip now suppresses the width transition for a
viewport-driven re-allocation and restores it a frame later, so add/remove and
close-slide animations are unchanged. The lag from measuring in JavaScript at
all — an observer frame before the widths are known — is not addressed.

## Problem

`ViewersAndSidebar` layout changes drive the strip's flex space:

- The left navigation sidebar (`web-workspace-layout.tsx`) slides out on
  `marginLeft`, freeing the content pane's flex space in one commit.
- The Session side panel (`desktop-session-detail-layout.tsx`) animates
  `flex-grow`/`min-width` over 220ms, so the chat column shifts every frame.

`AdaptiveTabStrip` measures that column with `observeResizeOnAnimationFrame`,
stores the width in state, and re-allocates each item's `width` through
`allocateAdaptiveTabStripLayout` (`adaptive-tab-strip.tsx:305`). Every item
element previously carried
`transition-[width,margin-inline-start] duration-200`
(`adaptive-tab-strip.tsx:648`). That duration is the `BoundsAnimator` copy for
removals and inserts (see
[rapid-close widths](../../implemented/feature/2026-09-18-tab-strip-rapid-close-widths.md)),
but it applied to the viewport-driven path too, where the target moves every
frame. The result is a first-order lag that persists until the panel stops and
then eases closed, read as "the tabs are slow by half a beat".

## Decision

`AdaptiveTabStrip` exposes `transitionEnabled` through its context and drops the
transition class from the item when it is false. It is true only while
`viewportWidth === settledViewportWidth`.

`settledViewportWidth` is separate state that lags behind the measured width by
one paint, restored by an effect on the next animation frame. Two details make
that necessary:

- The render-phase derived-state adjustment already used for removals re-runs
  the component before committing. A flag the adjustment block also set would
  therefore describe a render React discards — the check must read the previous
  commit's width, which is exactly what `settledViewportWidth` is.
- A layout effect restores before paint, so restoring there re-adds the
  transition to the same style recalculation that carries the new widths, and
  the resize animates after all. The restore waits a frame.

Tab ids are compared by VALUE (`itemIds.join('\u0000')`) in the adjustment
block. A parent re-render — which a sidebar toggle itself causes — rebuilds
`itemIds` as an equal-content array, so the previous identity comparison would
have classified every resize as a tab change and suppressed the transition in
exactly the wrong case.

A viewport-driven re-allocation is the only case that suppresses the animation.
A commit with a new item or a new selection still animates: it reaches the
`transitionEnabled` state through the normal render path, and the restore only
follows a changed `viewportWidth`.

## Alternatives considered

Deriving the flag directly from the pending `renderedViewportWidth !==
viewportWidth` comparison was tried and does not work: the adjustment block
consumes that value in the render it discards, so the committed render reads
equal widths and keeps the transition on — the resize still eases. Using a ref
written during render fails the same way, because React replays the component
and the ref no longer marks the first measurement when the committed render
runs.

Suppressing the transition until the pointer leaves the strip, mirroring
close-mode, was rejected: a resize has no pointer gesture to key off; it ends
when the panel stops moving.

Keeping the transition but shortening it was rejected as a guess: any non-zero
duration reproduces the per-frame restart, and zero is this change.

Fixing the JavaScript allocation itself (pure flex layout, so the browser sizes
the tabs in the same style recalculation as the panel) remains the deeper
answer. It changes `activeMinWidth` allocation semantics and a large body of
exact-pixel assertions, so it is left as separate work.

## Verification

`packages/components/tests/session-tab-bar.test.tsx` gained a regression that
widens the simulated viewport and observes the item elements: the commit that
writes the new widths carries no transition class, the next frame restores it,
and the resting state keeps it for the next add/remove. It fails against the
previous unconditional class. The existing rapid-close suite (close freeze,
slide margins, insert grow-in, substitution morph) still passes unchanged,
along with `adaptive-tab-strip`'s allocator tests: 39/39 in the three owning
files, 3763/3763 across `@lody/components`, `tsgo --noEmit` clean.

Not yet exercised in a running desktop build; the frame-level behavior during a
live panel drag is inferred from the state transitions the suite covers. The
one-frame lag from the JavaScript measurement path remains.
