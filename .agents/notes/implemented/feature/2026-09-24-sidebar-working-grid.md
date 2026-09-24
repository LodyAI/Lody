# Replace the sidebar working spinner with a shared-sea tile grid

Status: implemented
Translation: current

[中文](2026-09-24-sidebar-working-grid.zh.md)

## Abstract

The sidebar marked a running session with a rotating `Loader2` arc, which reads
as "loading" rather than "an agent is working", and five or six of them spin
independently down the list. The mark is now `WorkingGrid`, a 3×3 grid of tiles
that rise and sink with one sea shared by the whole page, built from two scales:
short ripples make the nine tiles of a mark differ and share one turning heading
across every mark, and long swells lift whole marks in turn so the list reads as
one rhythm. On mount each tile's motion over the sea's 36-second loop is baked into
one Web Animation of `transform` and `opacity`, pinned to the document timeline,
which the compositor plays with no per-frame script. Unmeasured: the renderer
cost of nine animated layers per mark in a packaged build.

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
  Tiles are at most 0.8 of their cell and shrink to 0.3 of it in a trough;
  opacity follows the sea down to 0.16.
- Ripples (60% of the height): four short waves, 3.2–4 cells long, heading
  down-right to down-left with periods 1.8–2.4s. Each one's strength swells and
  fades over 12–36s, out of step, so about two dominate at a time and interfere,
  and the heading they share keeps turning — the same heading in every mark at the
  same moment. Averaging four waves flattens them, so the ripple term is stretched
  back to full contrast.
- Swells (40%): two long waves, 18 and 26 cells, mostly downward, periods 6s and
  9s, that brighten and dim whole marks in turn down the list.
- Every period divides 36s, so the field loops seamlessly. One sea for the page:
  a tile's height depends only on its page position; in a list the sea between
  rows is skipped ("stitched", `rowPitch = 28`).

### Why two scales

The two properties pull against each other. A mark needs waves about its own size
so its nine tiles differ; a list needs waves many rows long so neighbouring marks
share a rhythm. Neither single scale works. Measured over 24 stitched rows
(within-mark spread is the mean standard deviation of the nine tile heights;
rhythm is the correlation of whole-mark brightness between adjacent rows):

| Field | Within-mark spread | Adjacent-mark rhythm |
|---|---|---|
| first version: two short waves | 0.26 | −0.83 (antiphase: every mark on its own) |
| four long waves only | 0.06 (all nine tiles move as one block) | 0.71 |
| **ripples + swells** | **0.21** | **0.49** |

Tests pin both: within-mark spread above 0.15 (fails when the ripples are
removed) and adjacent-mark correlation above 0.35 (fails when the swells are
removed), plus a check that a whole mark almost never sinks out of sight.

## Implementation choice

| Option | Result |
|---|---|
| rAF loop writing styles (the prototype) | Rejected: per-frame main-thread work and repaint, the cost the spinner fix removed. |
| CSS keyframes with per-tile `animation-delay` | Rejected: CSS animations start when an element mounts, so marks mounted at different moments would sit on different seas. |
| Two nested sine layers per tile (first version) | Replaced: a product of two fixed-direction sines cannot change heading, carry two scales, or vary strength over time. |
| **Bake each tile's height over the loop into one keyframe animation, `startTime = 0`** | Chosen: any periodic field, compositor-played, aligned to the document timeline regardless of mount time. |

Each tile samples the field 10 times a second over the 36s loop (361 keyframes,
linear between samples; the fastest ripple still gets 18 samples per cycle).
Baking costs a few thousand sine evaluations per mark at mount and nothing per
frame.

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

- `tests/working-grid.test.tsx`: the sea loops seamlessly; stitching makes
  consecutive rows continuous; the nine tiles of a mark differ, adjacent marks
  share a rhythm, and a whole mark almost never disappears (each checked against a
  field that should fail it); each of
  the 9 animations targets HTML, touches only `transform`/`opacity`, is a seamless
  loop pinned to `startTime = 0`, stays within `minScale`–`maxScale`, and is
  cancelled on unmount; reduced motion stays still; the sidebar end slot shows the
  grid while working.
- Rendered in Storybook (`UI/WorkingGrid`, `Components/LodySidebar` → All sessions
  working) and inspected by screenshot.
- Not done: a renderer CPU / layer trace in the packaged Electron app with many
  sessions running. That is the check to run before widening the grid to other
  surfaces.
