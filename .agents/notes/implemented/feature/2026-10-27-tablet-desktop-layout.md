# Tablet: use the desktop family, not a stretched mobile sheet

Status: implemented
Translation: current

[中文](2026-10-27-tablet-desktop-layout.zh.md)

## Abstract

Large tablets use the desktop interaction. The mobile full-height new-chat sheet
stays for phones and narrow split-view widths; it does not grow tablet-only
layouts. The existing `MOBILE_LAYOUT_BREAKPOINT` decision already implements
this, so no renderer code changed. The tablet variants (centered column, split
context, card) are rejected and kept only in the artboard as alternatives.

## Decision

- A device at or above `MOBILE_LAYOUT_BREAKPOINT` (768px) — iPad portrait or
  landscape included — renders the desktop family. A tablet below it (Split
  View, Slide Over, a small tablet in portrait) may render mobile.
- The mobile new-chat compose sheet and `MobileNewChatProjectSheet` are
  phone/split-view surfaces. Do not add tablet-specific versions of them.
- On a large tablet the project, machine, branch and run-config choices stay
  with the desktop selectors, not the mobile project sheet.

## Why

The 834px forced-mobile preview showed the costs directly: the prompt starts at
the screen edge, the footer spreads across the width, and the send button sits
hundreds of points from the chips. Centering the column (T1), splitting context
into a sidebar (T2), or turning the sheet into a card (T3) would each add a
third layout family to maintain. The desktop landing already provides the
interaction the width deserves.

## Rejected alternatives

- **T1 — centered 680px column**: smallest tablet-only change, but still a
  second tablet layout.
- **T2 — split context sidebar + writing column**: uses the width, but moves
  controls and duplicates desktop structure.
- **T3 — centered 720px card over the home list**: native-feeling modal, but a
  different presentation from both phone and desktop.

## Evidence

- `packages/components/tests/mobile-layout-selection.test.tsx` pins a wide
  Android tablet at 1280 → desktop, a portrait iPad at 834 → desktop, and a
  600px split-view tablet → mobile.
- The decision follows the existing `use-mobile.ts` comment and
  [ui-mobile.md](../../../docs/ui-mobile.md).
- The tablet variants were removed from the Ryugi artboard after the decision;
  the forced-mobile tablet screenshot remains only as a labeled responsive check,
  not a target.

## Outcome

No renderer change. The artboard no longer carries a tablet decision, and the
UI-mobile doc states the boundary explicitly; the portrait-iPad test prevents a
future "make the sheet fit tablets" change from silently reintroducing the
stretched-phone state. Device testing of
Split View remains open.
