# Restore caret placement for the composer mention menu

Status: implemented
Translation: current

[中文版](2026-09-29-composer-mention-follows-caret.zh.md)

## Abstract

The desktop composer's mention menu stayed aligned to the input box when the
caret moved, which made completions appear away from the text being edited.
The menu now uses the existing caret placement by default, prefers the space
below it, and flips above when needed. The virtual anchor also uses the current
insertion position rather than the trigger character, so typing within a query
actually moves the popup. Browser exploration then exposed incorrect soft-wrap
coordinates, missed layout shifts, an off-screen tall menu, and a mobile dock
covering controls above the textarea. Those edges now use measured layout and
visible frame bounds.

## Decision and trade-off

`MentionTwoLevelMenu` defaults to `anchor="caret"` and `side="bottom"` for both
the main composer and the inline editor. `MentionInput` refreshes that anchor
from the current selection position on input and selection updates. Its old
`textWidth % inputWidth` estimate was wrong for word wrapping (74px of
horizontal error in a real browser); a temporary unscaled mirror now measures
the caret and maps it through textarea scroll and container scale. The virtual
anchor names the textarea as `contextElement` so floating-ui observes layout
movement even when the selection is unchanged.

The fixed composer-anchor mode remains available to an explicit caller. The
main composer marks its frame again, but only the mobile dock uses that marker
by default: attachment and control rows belong below the dock, not behind it.
The dock observes frame resizing and caps itself to the actual room above the
frame. For caret menus, `fitViewport` caps a too-tall surface and the surface
permits scrolling. `MentionContent` now preserves caller inline styles; its
wrapper previously overwrote them with StyleX's empty `style`, which blocked
the scroll treatment.

The previous [composer-frame decision](../feature/2026-09-25-composer-mention-menu-v2.md)
prevented a short first level and taller second level from jumping between the
caret's two sides or overlapping chips. Restoring caret placement accepts that
the menu may flip between levels when space changes; it keeps completion close
to the text and uses the existing viewport collision behavior. The later
[top-pinning fix](2026-09-26-mention-menu-pinned-above-input.md) remains a
historical account of the frame-anchored design.

## Verification

In Chromium, the real Storybook menu followed a wrapped `@` query at the caret
(x≈414px), flipped above the bottom composer, remained reachable in a 650×250
desktop viewport, and committed a row by mouse and keyboard. The mobile Storybook
menu stayed above the entire frame at 390×640 and selected a second-level Issue
without losing textarea focus. A minimal page exercising the same primitive
reproduced the wrap error (caret x≈616px, menu x≈542px) before the fix, then
matched after it; it also reproduced and verified the layout-shift and mobile
frame fixes. The 390×250 extreme viewport now clips the mobile dock to the
actual space above the top inset rather than placing most of it off-screen;
that geometry cannot fit a full row while retaining the composer and inset.

Behavioral tests cover the virtual anchor's current position and observation
target, wrapper style forwarding, and mobile frame docking/capping. The
selected component suites pass (41 tests). Release web deployment remains
unverified in this checkout.

## Links

- [Placement Spec](../../../../specs/composer-mention-menu-placement.md)
- [Edit-and-resend decision](../feature/2026-09-28-edit-resend-mentions.md)
- [Main-composer upward placement](2026-09-29-main-composer-mention-above-frame.md)
