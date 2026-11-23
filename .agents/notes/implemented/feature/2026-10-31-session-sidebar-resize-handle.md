# Session side-panel resize handle: one centred ink block

Status: implemented
Translation: current

[中文](2026-10-31-session-sidebar-resize-handle.zh.md)

## Abstract

The desktop session split painted a full-height 2px accent line on hover or
drag, which read as a second divider competing with the side panel's own
hairline and had no keyboard state at all. The handle now paints nothing at
rest and reveals one small monochrome block centred on the seam: a soft,
28px-tall block on hover, a darker, 1.25× taller block on keyboard focus, and
the darkest on drag. The pointer target still comes from the 12px hit-area
margins rather than element width, so the visual never changes panel geometry
and the hairline stays the only divider. Verified in Storybook with hover,
focus and drag measured through computed styles; reduced-motion and packaged
Electron rendering were not separately exercised.

## Problem

- The old hover line covered the side panel's left hairline for its full
  height, so the divider changed colour and thickness instead of gaining a
  grab affordance.
- It used `--sidebar-ring`, an accent colour; the surrounding chrome is
  monochrome, and an accent line read as a status or selection signal.
- `react-resizable-panels` makes the handle a focusable separator, but the
  old styling had no focus state: keyboard users saw nothing (the global
  focus ring is applied to a 1px-wide, full-height element) and could not tell
  where they were.

## Design

- The handle element stays 1px wide and transparent; the visible mark is a
  child of the primitive (`ResizableHandle` now renders caller children instead
  of the registry grip), so the block cannot affect flex sizing.
- One 3×28px `rounded-full` block in `foreground`, invisible at rest. States
  are driven by the library's own data attributes plus `:focus-visible`:
  hover 30% ink, focus 50% ink at `scale-y-125`, drag 70% ink at the same
  scale. Focus and drag differ from hover by both weight and height, so a
  keyboard-focused handle is distinguishable even while the pointer rests on
  it.
- The global inset focus ring is suppressed on this element
  (`focus-visible:shadow-none`); the block itself is the focus indicator.
  `aria-hidden` keeps the decorative block out of the accessibility tree while
  the separator keeps its role and label semantics. The resize cursor stays the
  library's (it sets `ew-resize` on the document while hovering), so the block
  does not add a second, conflicting cursor.

## Verification

- `packages/components/tests/desktop-session-detail-layout.test.tsx` passes (11
  tests); `tsgo --noEmit` for `@lody/components` is clean.
- Storybook `Sessions/DesktopSessionDetailLayout` measured the block through
  computed styles: rest `opacity: 0`; hover `3×28`, ink 30%; focus `3×28`
  scaled 1.25, ink 50%, `focus-visible` true, box shadow transparent; drag ink
  70%. Screenshots confirmed nothing is painted at rest.
- Not verified: reduced-motion timing, dark theme by eye, and the packaged
  Electron window.
