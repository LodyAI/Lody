# Replace the sidebar working spinner with a shared-sea tile grid

Status: implemented
Translation: current

[中文](2026-09-24-sidebar-working-grid.zh.md)

## Abstract

The sidebar marked a running session with a rotating `Loader2` arc, which reads
as "loading" rather than "an agent is working", and five or six of them spin
independently down the list. The mark is now `WorkingGrid`: a whole 3×3 grid of
tiles in the primary colour across which a slow light drifts, driven by two short
waves crossing the page plus one long rhythm wave that brightens whole marks in
turn down the list; every tile samples them at its own page position. Every mark
holds still while the user reads outside the sidebar. The animation runs on the
compositor through Web Animations of `transform` and `opacity` on one shared
clock, with no per-frame script. Unmeasured: the renderer cost of 19 small
animated layers per mark in a packaged build, and the effect on real readers.

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

- 3×3 tiles, corner radius 40% of the tile, gap 0.18 of the tile, 12px overall
  inside the 14px status slot, in the primary colour.
- A whole grid with light crossing it: all nine tiles always show (size 0.8–0.9
  of their cell), and opacity carries the motion, from 0.25 (pale tiles) to 1
  (primary tiles). Still, it is a clean dot matrix; moving, a slow light drifts
  across it.
- Texture: two plane waves, 3.2 and 4.4 cells long (× wavelength 1.2), heading
  down-right and down-left. Rhythm: one long wave straight down, 36 cells (about
  twelve stitched rows) crest to crest, carrying 30% of the opacity range so
  whole marks brighten in turn down the list. Everything plays at 0.6× (about
  3.2s and 4.5s for the texture, 6s for the rhythm).
- One sea for the page: a tile's phase depends only on its page position. In a
  list the sea between rows is skipped ("stitched", `rowPitch = 28`): the 14px
  mark covers half of each 28px row, and without stitching a wave moves more than
  a wavelength between rows, so neighbours looked unrelated.

## Staying out of the reader's way

In the first shipped form (primary blue, opacity 0.16–1, size 0.3–0.9, full
speed, every mark moving) a sidebar of running sessions kept pulling the eye from
the conversation. Reading apps keep their chrome in the background: low contrast,
still by default, motion only for a change of state, accent colour only for what
needs the reader. Peripheral vision is most sensitive to luminance change and
motion, and many unrelated flickering points cannot be tuned out. So:

- Luminance and colour, in three rounds. First: opacity 0.5–0.8, size 0.55–0.9,
  muted grey, 0.45× — the owner found it too static to notice. Second: a 12px
  mark whose tiles shrink through zero (minimum -0.2) — rendered, the grid broke
  into scattered specks that looked like noise, were ugly when still, and were
  not recognisable; counting tiles under 30% size as invisible, a mark showed two
  or fewer tiles ~29% of the time. Final: keep the grid whole (size 0.8–0.9) and
  move light instead (opacity 0.25–1), in the primary colour so it reads as
  activity, at 0.6×. Candidates were compared in the production-geometry story
  before choosing; the grid shape keeps it distinct from the unread dot.
- Coherence: the whole-mark rhythm makes a column read as one pulse travelling
  down, instead of about a hundred independently changing tiles.
- Reading pause: any wheel, key, pointer or touch press outside
  `[data-working-grid-region]` (the sidebar root) freezes every mark on its
  current frame; marks resume after 4s of quiet or when the pointer enters the
  sidebar. `scroll` is deliberately not a signal: a streaming conversation
  scrolls itself. Pause and resume are the only script involved; all marks keep
  one clock offset, so they resume in step.

The reading pause is what keeps the more visible final form from pulling at the
reader. None of these effects has been measured on people; the numbers above are
simulations and screenshots.

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

## Explored and reverted

After this shipped, several fields were tried in Storybook and the owner chose to
return to the configuration above:

- Softer defaults (20–30% corners, 0.25–0.35 gap, tiles capped at 0.8 of the
  cell) and shorter or longer wavelengths (0.8–1.3) with faster waves.
- Four long waves whose strengths took turns dominating: neighbouring marks moved
  together, but all nine tiles of a mark moved as one block.
- Short ripples plus long swells: varied tiles and a shared rhythm, but never a
  random-looking single tile.
- Per-tile random bobbing plus occasional bands sweeping across all marks.

Those variants baked each tile's height over a 36s loop into one keyframe
animation instead of two nested sine layers; that technique remains the route if
the field changes again.

## Tuning surface

`UI/WorkingGrid` in Storybook exposes every parameter as a control (shape, scale
mode, minimum and maximum size, opacity range, rhythm share, speed, gap,
wavelength, direction, stitching, muted or primary colour) and
a `SidebarSimulation` story at production geometry: 28px rows, the trailing
status slot that swaps to Archive on hover, waiting and unread marks beside
working ones. `Components/LodySidebar` → All sessions working shows the real
sidebar with every session running.

## Verification

- `tests/working-grid.test.tsx`: the delay reproduces the travelling wave at any
  timeline time; stitching makes consecutive rows continuous; the rhythm steps
  down a list in small increments; all 19 animations (one rhythm, eighteen tile
  layers) target HTML, touch only `transform`/`opacity`, share one start time,
  follow the speed factor, stay within the size and opacity ranges, and are
  cancelled on unmount; reduced motion stays still; input outside the sidebar
  region pauses every loop until 4s of quiet or the pointer returns, and they
  resume on one clock; the sidebar end slot shows the grid while working.
- Rendered in Storybook and inspected by screenshot.
- Not done: a renderer CPU / layer trace in the packaged Electron app with many
  sessions running. That is the check to run before widening the grid to other
  surfaces.
