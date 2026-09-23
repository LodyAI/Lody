# Keep a dropdown submenu off the screen edge and off its parent menu

Status: implemented
Translation: current

[中文](2026-09-15-menu-submenu-gap-and-viewport-margin.zh.md)

## Abstract

The composer's run-config submenu — the Model list, the tallest of them — rendered flush against the bottom of the window and welded to the right edge of its parent menu, with no visible gap between the two surfaces. Both symptoms came from `DropdownMenuSubContent` leaving Radix's `collisionPadding` at its default of 0 while its `sideOffset` of 6 was measured from the trigger ROW rather than the parent surface's edge. The fix gives every submenu the same safe-area-aware collision padding the top-level menu already had, extracted into a shared `useSafeAreaCollisionPadding` hook, and raises the submenu offset to 10 so the two surfaces separate. Measured in Chromium at a 900×470 viewport: the bottom margin went from 0px to 8px and the inter-surface gap from 2px to 6px. The offset is a fixed number tuned to the current surface padding and hairline ring, not derived from them, so changing either silently narrows the gap again.

## What actually caused each symptom

`DropdownMenuContent` has merged the device safe area into an 8px `collisionPadding` since it was written. `DropdownMenuSubContent` never did, so Radix used its documented default of 0. That padding is what floating-ui's `detectOverflow` consults, and Radix derives `--radix-dropdown-menu-content-available-height` from the same computation — so a submenu taller than the room below its trigger was both *shifted* to the viewport edge and *capped* at it. The Model submenu caps itself with `min(20rem, var(--radix-dropdown-menu-content-available-height))`, which is why it was the visible case: it is the one long enough to collide.

The missing gap is arithmetic, not a collision. `sideOffset` offsets the submenu from its anchor, and a submenu's anchor is the `SubTrigger` row, which sits inside the parent surface's `p-1`. `menuSurfaceStyle` then paints each surface's edge as a `0 0 0 1px` ring OUTSIDE its border box. So the visible separation was `6 − 4 (padding) − 1 − 1 (two rings) = 0px`, and the two menus read as one slab. Confirming that against the reported screenshot, read pixel by pixel at its 2x scale: the 2px box gap is filled exactly by the two rings (4 device pixels, 2 per ring), leaving no background column between them.

## Verification and limits

- Reproduced and fixed in real Chromium through a throwaway Vite page rendering the actual `DropdownMenu` primitives at a 900×470 viewport, with the submenu tall enough to collide. Before: `bottom margin 0px`, `gap 2px`, `--radix-popper-available-height: 470px` (the full viewport). After: `bottom margin 8px`, `gap 6px`, `available-height 454px`.
- `tests/session-switch-render-cost.test.tsx` covers `useSafeAreaCollisionPadding` directly — the 8px floor, the safe-area addition, and a caller's larger per-edge request winning. `tests/dropdown-menu.test.tsx` still passes; it asserts focus and open-state behavior, which this does not touch.
- jsdom performs no layout, so no test asserts the resulting geometry. The 8px/6px numbers above rest on the browser measurement, not on the suite.
- `PopoverContent` and `DropdownMenuContent` each carried their own copy of the merge; both now call the shared hook. That is a refactor with no behavior change — the hook reproduces the previous per-edge `Math.max` exactly.
- Only `ui/dropdown-menu.tsx` is fixed. `ui/context-menu.tsx` and `ui/menubar.tsx` wrap different Radix primitives and still pass no `collisionPadding`; they were out of scope for the reported defect and remain unexamined.
