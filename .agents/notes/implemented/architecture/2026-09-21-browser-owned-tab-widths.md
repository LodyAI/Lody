# Tab widths are laid out by the browser

Status: implemented
Translation: current

[中文](2026-09-21-browser-owned-tab-widths.zh.md)

## Abstract

The desktop Session tab strip allocated integer tab widths in JavaScript from a
measured viewport width and wrote them back as inline styles. That put every
resize behind a `ResizeObserver` round trip and a React commit, and let each
tab's 200ms width transition chase a moving target, so toggling a sidebar made
the tabs settle a beat after the panel they live in. The row is now plain flex
(`flex: 1 1 0`) that the browser sizes in the same style recalculation as the
panel, with the active tab's 180px minimum pinned by a container query on the
strip. Sidebars and window resizes need no measurement and no per-frame width
writes. The active tab's mid-range cap is gone: below the query threshold the
tabs divide evenly instead of pinning the active one while its siblings
collapse.

## Problem

`AdaptiveTabStrip` stored a measured `viewportWidth`, derived every item's
`width` through `allocateAdaptiveTabStripLayout`, and applied it as an inline
style plus a 200ms `transition-[width]`. A sidebar toggle changes the strip's
flex space (the left navigation bar frees it in one commit; the Session side
panel animates `flex-grow` over 220ms), and each observed frame restarted the
ease toward that frame's target. The lag was structural: the DOM width could
only change after an observer callback and a React commit.

## Decision

`AdaptiveTabStrip` no longer measures or writes resting widths:

- The strip is a flex row (`gap`, padding) and every item is `flex: 1 1 0` with
  `min-width: 0`. The browser resolves the widths during the same style
  recalculation that resolves the panel around it, so no observer and no state
  are involved.
- The active tab keeps `ACTIVE_TAB_MIN_WIDTH` through
  `@container-[366px]:min-w-(--tab-active-min-width)`, with the length passed
  as a custom property on that item. The strip viewport is the container
  (`container-type: inline-size`); the 366px threshold is a little over twice
  the minimum — the width at which pinning stops starving the inactive tabs —
  and is a validated constant rather than a computed value because Tailwind
  needs the complete class literal in the source.
- `ResizeObserver` survives only to release a frozen layout when the strip
  shrinks below the width captured for that gesture; it writes a ref and
  touches no other state.

The close-mode freeze is unchanged in behavior but now takes its geometry from
the DOM. `captureStripGeometry` snapshots each item's painted width, its slide
margin, and the strip's padding on `pointerdown` — the only way a close
gesture can start — so the freeze and its slide margins have numbers to work
from without tracking the viewport on every frame. Frozen items are the one
place the strip still writes an explicit width. The item's right margin is not
the gap (the gap is the parent's `gap`), so the capture falls back to the
configured gap for that value.

The 200ms width transition is back on unconditionally: with the browser owning
resting widths it only ever fires for a frozen release, an insert or a removal.
The `transitionEnabled` context and the viewport-lag state it needed are gone.

## Alternatives considered

A fixed `min-width` with no container query overflows a narrow strip (measured:
214px of tabs in a 120px container) instead of shrinking them, so the query is
what makes a single `min-width` safe.

Making each item its own container (`container-type: inline-size` on the item,
query `@container (min-width: 180px)`) was tried and rejected: the query then
measures the item's own box, and with `flex: 1 1 0` the active tab never
reaches 180px in the mid-range where it should pin.

Deriving the threshold from the row algebra (`2M + (g(n−1) + 2P)/n`) was tried
and rejected after it mispredicted the boundary. Any value in roughly
[365, 375] px behaves identically across the valid tab-count range, so the
constant is validated by the engine comparison below rather than computed.

## Superseded decisions

- [Live-resize tab widths](../../archived/bug-fix/2026-09-21-tab-width-live-resize.md) suppressed the
  transition for viewport-driven reallocations as a patch on the JavaScript
  allocation this note removes. Its behavior is folded in here.
- [Rapid-close width freeze](../feature/2026-09-18-tab-strip-rapid-close-widths.md)
  still owns the freeze semantics. Its `AdaptiveTabStrip` layout internals are
  superseded; the freeze itself is unchanged apart from reading a DOM snapshot.

## Verification

Chromium 152 comparison against `allocateAdaptiveTabStripLayout` across every
width and tab count from 190px to 2400px: the only differences are ±1px from
the allocation's `Math.floor` remainder (flex divides the remainder evenly
instead), with the active tab pinned at 180px in both. Below the threshold the
old allocator pins the active tab even when the budget cannot afford it — at
200px with two tabs it resolves 178/0 — while flex divides evenly, which is the
one deliberate behavior change.

`packages/components/tests/session-tab-bar.test.tsx` (23 tests) was rewritten
around the new model: a jsdom stand-in supplies the flex result for
`getBoundingClientRect` so the freeze, slide margins, frozen re-spread, and the
viewport-shrink release are exercised; the resting row is asserted to carry no
inline width and the active pin. `@lody/components` passes 3762 tests and
`tsgo --noEmit` is clean. Not yet exercised in a running desktop build; the
container query itself is CSS and is covered by the engine comparison above
rather than by jsdom.
