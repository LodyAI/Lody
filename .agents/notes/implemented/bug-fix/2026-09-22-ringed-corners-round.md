# Ringed controls use round corners

Status: implemented
Translation: current

[中文](2026-09-22-ringed-corners-round.zh.md)

## Abstract

A focus ring on a squircle-cornered control visibly bulged off the corner tangents in
Chromium — the browser draws a spread `box-shadow` on a superellipse as
`superellipse(radius + spread)`, which is not a parallel offset of the original curve.
On a 10px-radius field the gap between the 2px accent ring and the painted edge grew
from 2px to about 7px near the corner, reading as a border that overshoots the control.
Every control whose edge carries the ring — the field wells, Button, Toggle, and the
disclosure rows, tabs and panels — now uses `corner.round`, where a spread shadow is a
true parallel curve. Surfaces that never take the ring keep `corner.shape`, as do the
0.5px hairline rings on popup surfaces, whose divergence is below a pixel.

## Discovery

The report was a screenshot of the password field whose accent ring floated off the
field's corners. Pixel measurement showed the ring flush on the straight edges (2px,
as designed) but the corner gap widening severalfold. Reproduced in Chrome 153 on a
bare `corner-shape: squircle` + `box-shadow: 0 0 0 2px` element: the shadow's corner
arc follows a scaled superellipse rather than a parallel offset, so it drifts outward
near the tangent points. `outline` produces byte-identical divergence — Chromium
walks the same parameterized path for every stroke primitive — and a pseudo-element
border or a nested accent layer hits the same wall, since CSS cannot express a
parallel offset of a superellipse.

## Alternatives

- Keep the squircle and accept the wedge: the artifact is most visible on Retina
  captures, but it is present at 1x and reads as a defect against the field edge.
- Make the ring an inner accent border instead of an outer ring: the border's outer
  edge is the control's own squircle, so it can never overshoot — but it changes the
  design language from an offset ring to a flush border and reserves border-box space.
- Drop `corner-shape` everywhere: throws away the squircle language on cards, menus
  and dialogs where no ring exists and nothing is wrong.

Round on ringed controls keeps the outer-ring design and costs the squircle only on
small controls, where a 10px squircle and a 10px circle are already hard to tell
apart. It extends the existing `radius.full` exception rather than inventing a new
mechanism.

## Outcome and limits

`corner.round` is applied in `field/well.ts` (`base`, `shell`, `box`), `button`,
`toggle/surface.ts`, `disclosure/surface.ts` (`tab`, `tabPanel`, `row`) and the two
gallery focus replicas, which demo the ringed state. The invariant now lives in
`packages/ui/AGENTS.md` and `test/toggles.test.tsx` asserts the round class reaches
the rendered Checkbox, Input and PasswordInput shell. Verified by pixel-measuring a
focused field in Storybook: the ring-to-edge gap is constant around the corner.

Limits: this is Chromium's renderer simplification; a future parallel-offset
implementation would make squircle rings hug again, but nothing in CSS can force it
today. Non-Chromium engines ignore `corner-shape` and were already round.
