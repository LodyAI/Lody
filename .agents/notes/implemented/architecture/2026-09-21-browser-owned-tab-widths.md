# Tab widths are laid out by the browser

Status: implemented
Translation: current

[中文](2026-09-21-browser-owned-tab-widths.zh.md)

## Abstract

The Session tab strip uses browser flex layout so its widths follow the surrounding
panel without a measured-width React update and a trailing 200ms transition.
Only rapid-close mode captures and pins DOM widths. Resting layout, including the
first render of multiple restored tabs, has no width transition. Browser regression
tests cover actual spacing, active minimum, resize tracking, pointer-close freezing
and the initial paint; jsdom layout substitutes cannot establish these guarantees.

## Decision

`AdaptiveTabStripItem` uses `flex: 1 1 0` at rest. Each item's trailing margin owns
the gap in both resting and frozen layouts; the parent must not add a second gap.
The viewport is an inline-size container. The active item's
`@[366px]:min-w-(--tab-active-min-width)` rule pins its minimum at 180px above the
threshold. Below 366px, this branch deliberately divides the space equally rather
than retaining the old allocator's active-first allocation.

On pointerdown, `captureStripGeometry` reads the painted widths and margins.
The existing [rapid-close rules](../feature/2026-09-18-tab-strip-rapid-close-widths.md)
then retain explicit widths, including promoting the newly active tab to the
captured active width. Only this explicit layout enables width and slide-margin
transitions. Returning to flex and initializing/restoring tabs apply immediately.

`ResizeObserver` updates a width ref and clears frozen state only when the viewport
actually shrinks below the captured width. It must not enqueue an identity updater
on every observation: React can replay an eagerly evaluated null update after a
discrete close event and overwrite the render-phase freeze.

## Correction to the original verification

The original claim of browser parity was not supported by the running component.
The original `@container-[366px]` variant generated no minimum-width rule, row gap
and item margins doubled the spacing, and unconditional observer updates discarded
the freeze after real clicks. The jsdom suite supplied geometry using the old
allocator and did not catch these browser failures. Instrumentation confirmed that
pointerdown captured all items successfully; changing event propagation was not
the required fix.

## Verification

`tests/e2e/session-tab-widths.spec.ts` exercises the real Storybook component in
Chromium. A paused container animation checks layout at explicit animation times;
real clicks check repeated freezes and pointer-leave release; initial DOM geometry
and active width transitions are observed from page startup. All three browser
tests and the 23 tests in `tests/session-tab-bar.test.tsx` pass; the latter remains
the state-machine suite. Component typechecking also passes.

The earlier [live-resize patch](../../archived/bug-fix/2026-09-21-tab-width-live-resize.md)
suppressed transitions around JS allocations. Browser layout avoids that per-frame
measurement and write loop. Full packaged Electron startup remains outside this
component-level verification.
