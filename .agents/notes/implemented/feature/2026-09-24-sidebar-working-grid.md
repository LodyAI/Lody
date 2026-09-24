# Replace the sidebar working spinner with a shared-sea tile grid

Status: implemented
Translation: current

[中文](2026-09-24-sidebar-working-grid.zh.md)

## Abstract

The sidebar marked a running session with a rotating `Loader2` arc, which reads
as "loading" rather than "an agent is working", and five or six of them spin
independently down the list. The mark is now `WorkingGrid`, a 3×3 grid of tiles
that rise and sink with two waves crossing the whole page; each tile samples the
waves at its own page position, so marks in neighbouring rows look like one body
of water. The animation runs on the compositor: every tile is two nested HTML
layers, one per wave, animating only `transform` and `opacity` through Web
Animations pinned to the document timeline's origin, with no per-frame script.
The main unmeasured cost is layer count: 18 small animated layers per mark, which
has not been profiled in a packaged build.

## Problem

- A spinner says "wait for me". A session that is working says "I am busy on
  your behalf"; the product wanted something calmer, more on-brand (the jellyfish,
  water) and still professional.
- Several spinners in one list rotate out of step and draw the eye. Marks that
  move as one system are quieter than marks that each twinkle.
- Any replacement must keep the constraint already paid for in the
  [spinner note](../bug-fix/2026-09-13-spinner-off-svg-retina-composite.md) and
  `components/shared/AGENTS.md`: no main-thread work per frame while agents run.

## Design

The look was chosen by iterating on standalone prototypes with the product owner:
pixel jellyfish and a dot "ocean patch" read as too cartoonish or too noisy;
breathing dots, rings, bubbles and a click-ripple layer were tried and dropped.
The kept form and its defaults:

- 3×3 tiles, corner radius 30% of the tile, gap 0.35 of the tile, 14px overall.
- Two plane waves, 3.2 and 4.4 cells long (× wavelength 1.5), periods 1.9s and
  2.7s (19:27, so the pattern repeats only after ~51s), travelling down-right and
  down-left. Tiles scale from their centre to a minimum of 0.3 and brightness
  follows the wave down to 0.16 opacity.
- One sea for the page: a tile's phase depends only on its page position. In a
  list the sea between rows is skipped ("stitched", `rowPitch = 28`): the 14px
  mark covers half of each 28px row, and without stitching a wave moves more than
  a wavelength between rows, so neighbours looked unrelated.

## Implementation choice

| Option | Result |
|---|---|
| rAF loop writing styles (the prototype) | Rejected: per-frame main-thread work and repaint, the cost the spinner fix removed. |
| CSS keyframes with per-tile `animation-delay` | Rejected: CSS animations start when an element mounts, so marks mounted at different moments would sit on different seas. |
| **Web Animations, `startTime = 0`, per-tile delay from the phase** | Chosen: compositor-driven, and every loop is aligned to the document timeline regardless of mount time. |

A sum of two sines cannot be one keyframe loop, so each tile nests two layers,
one per wave, and their scales and opacities multiply. Each layer spans the
square root of the full range, so a double trough lands exactly on the minimum.
The product of two waves reads the same as the prototype's sum: crest on crest is
largest, trough on trough smallest.

`prefers-reduced-motion` and engines without `Element.animate` render the grid
still. Superellipse tiles are available through CSS `corner-shape`
(Chromium 139+, Electron 39 ships 142).

## Tuning surface

`UI/WorkingGrid` in Storybook exposes every parameter as a control (shape,
brightness, scale mode, minimum size, gap, wavelength, direction, stitching) and
a `SidebarSimulation` story at production geometry: 28px rows, the trailing
status slot that swaps to Archive on hover, waiting and unread marks beside
working ones.

## Verification

- `tests/working-grid.test.tsx`: the delay reproduces the travelling wave at any
  timeline time; stitching makes consecutive rows continuous; all 18 animations
  target HTML, touch only `transform`/`opacity`, are pinned to `startTime = 0` and
  are cancelled on unmount; reduced motion stays still; the sidebar end slot shows
  the grid while working.
- Rendered in Storybook and inspected by screenshot.
- Not done: a renderer CPU / layer trace in the packaged Electron app with many
  sessions running. That is the check to run before widening the grid to other
  surfaces.
