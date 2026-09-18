# Tab strip rapid-close width freeze

Status: implemented
Translation: current

[中文](2026-09-18-tab-strip-rapid-close-widths.zh.md)

## Abstract

The desktop Session tab strip always divided its full width among visible tabs,
so closing one tab immediately re-expanded the survivors and the next tab's
close button moved away from the cursor. The strip now implements Chromium's
rapid-close mode (`in_tab_close_` / `override_available_width_for_tabs_`): a
pointer-triggered close freezes every surviving tab at its current width so the
next close button lands under the cursor, removals slide closed and inserts
grow in over a 200ms transition, and the freeze survives inside an expanded
pointer region (40px below the strip, 60px toward the new-tab button) instead
of releasing at the strip edge. The freeze releases on leaving that region, a
tab add, a viewport shrink below the captured width, or a single remaining
tab. The trade-off is a temporarily under-filled strip while the pointer
lingers, matching Chrome.

## Decision and evidence

`AdaptiveTabStrip` (`packages/components/src/components/sessions/adaptive-tab-strip.tsx`)
owns the behavior, so every consumer of the strip gets it for free. A
`pointerdown` inside the viewport arms the gesture (a timestamped ref); when
`itemIds` shrinks within a short window the previously applied layout's
per-item widths are captured into a `FrozenTabStripLayout`, and the layout memo
rebuilds item widths from that map instead of calling
`allocateAdaptiveTabStripLayout`. The removal diff runs DURING RENDER —
React's derived-state adjustment against the last committed
ids/selection/viewport — so a removal commit's first painted frame already
carries the frozen widths. An earlier version decided the freeze inside
`useLayoutEffect`: the removal render first committed the freshly allocated
widths, the effect installed the freeze, and a second render wrote them back,
so a style recalculation between the commits (a measuring layout effect in a
child, an observer read) seeded a width transition that flashed survivors at
the unfrozen width for a frame. The same render-phase block computes the
slide margins and entering widths with direct values, never updater
functions, so StrictMode's double render cannot compound them.

The semantics mirror `chrome/browser/ui/views/tabs/tab_strip.cc` and
`tab_container_impl.cc`:

- Enter only on a pointer-triggered removal (`CloseTabSource::kFromMouse`
  equivalent): the pointerdown arm means a keyboard or programmatic close while
  the pointer hovers the strip relayouts normally instead of freezing.
- Consecutive removals keep the same frozen widths, so repeated clicks keep
  working. The freeze only arms on entry; once frozen, removals inside the
  region do not need to re-arm.
- Exit is pointer-position driven through Chromium's `MouseWatcher` region —
  the strip bounds grown 40px downward and 60px toward the new-tab button — so
  drifting toward `+` or slightly below the strip does not re-expand
  mid-gesture. A window-level `pointermove` listener releases the freeze once
  the pointer leaves that region.
- Chromium's available width is `min(override, real)`: a wider viewport keeps
  the captured widths; a narrower one releases on the next commit.
- Closing only the LAST tab never enters the mode — the new last tab already
  ends at the right edge. Chromium also never shrinks the frozen budget for a
  trailing removal, so closing the last tab while frozen re-spreads the
  survivors over the width the strip already occupied, keeping the new last
  tab's right edge — and its close button — under the cursor.
- Chromium exits close mode once a single visible tab remains; a sole survivor
  expands to the full row immediately.
- Reordering while frozen keeps the captured per-id widths in the new order.
- Widths freeze by role, not strictly by id. Chromium compensates for the
  active width when an active tab closes (`size_delta = next_active_tab
  ->width()`), so the capture stores the active and inactive widths alongside
  the per-id map: a survivor that becomes active mid-freeze takes the captured
  active width, and the previously active tab drops back to the inactive width.
  Because a close plus re-selection can land in one commit, the previous
  commit's active id — read from a ref, not the current prop — decides which
  captured layout owns the active width.

Animations mirror `BoundsAnimator`'s 200ms duration. On a removal, the first
surviving item after each removed slot starts with a `margin-inline-start`
equal to the freed width+gap and eases it to zero, which reads as the gap
collapsing under the tabs that follow; an inserted tab starts at zero width and
grows into its allocation. Both are CSS transitions retargeted one frame after
they apply, so `motion-reduce` users get the same resting geometry without the
motion, and dnd-kit's inline transform transition still wins during drags. The
closing tab itself is not kept mounted for a shrink animation — Chromium
retains it in the model while contracting — so our slide is an approximation
rather than a frame-exact copy.

Animation cleanup correction: retargeting clears the temporary margin map;
missing entries render as zero while CSS completes the transition. Keeping
zero-valued entries recreated a non-empty map every frame, retriggering the
effect and React commits indefinitely after a middle-tab close.

Two grow-in refinements keep the insert animation honest. A commit that
removes AND adds is a substitution, not an insert — a draft promoting to a
session, or an auto-created draft replacing a closed tab — so the replacement
morphs from the nearest removed item's width instead of appearing from zero
(which read as the auto-selected successor "growing from nothing"). And a lone
tab added to an empty strip skips the animation entirely, rendering at its
final width: with no sibling geometry a grow-in only reads as materializing.

## Alternatives considered

A time-based release (re-expand a fixed delay after each close) was rejected:
desktop Chromium has no timer — it exits on mouse leave — and a delay either
feels arbitrary or re-expands under a still-hovering cursor, reintroducing the
moving target the feature exists to remove. Keeping a ghost of the closing tab
mounted to animate its own contraction was rejected: sortable items are nested
inside `DndContext`/`SortableContext`, so injecting a spacer child would fight
the drag layer for marginal visual gain over the slide. WAAPI keyframes for the
slide were rejected because jsdom lacks `Element.animate`, making the behavior
untestable; state-driven margins exercise the same path in tests.

## Verification

`packages/components/tests/session-tab-bar.test.tsx` gained a rapid-close suite
(jsdom, mocked `clientWidth` and `ResizeObserver`): middle-close freeze, slop
boundary inside and outside the expanded region, consecutive closes, the
survivor slide margin, unfrozen last-tab relayout, the frozen trailing-close
re-spread, single-survivor release, viewport grow-keep/shrink-release,
unarmed programmatic close, active-close promotion, the insert grow-in, the
substitution morph-from-removed-width, the empty-strip solo insert, and a
MutationObserver regression asserting the active item's inline width never
holds the unfrozen value on a removal commit — 24/24 tests pass together with
the 7 existing `adaptive-tab-strip` allocator tests. The rapid-close suite uses
a manually advanced animation-frame queue. Its slide regression verifies both
the resting geometry and that subsequent frames produce no React commits or
pending callbacks; it fails against the original cleanup. The behavior was also
exercised in a real browser against Storybook
(`Sessions/SessionTabBar → Rapid Close`): closing a middle tab froze
survivors, the freeze held inside the 40px/60px slop region and released
outside it, a frozen trailing close re-spread survivors while keeping the last
tab's right edge (≈993px) under the cursor, `document.getAnimations()`
captured the survivor's margin-inline-start CSSTransition, and a new tab grew
in from `width: 0px`.
`tsgo --noEmit` reports no diagnostics in the changed files; the package still
shows unrelated pre-existing errors from missing Electron type packages in this
nested worktree. Not yet exercised in a running desktop build.
