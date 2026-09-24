# Replace the sidebar working spinner with a shared-sea tile grid

Status: implemented
Translation: current

[中文](2026-09-24-sidebar-working-grid.zh.md)

## Abstract

The sidebar marked a running session with a rotating `Loader2` arc, which reads
as "loading" rather than "an agent is working", and five or six of them spin
independently down the list. The mark is now `WorkingGrid`, a 3×3 grid of tiles
that rise and sink with one sea shared by the whole page: each tile bobs on its
own, so a single tile looks random, and now and then a band sweeps across the
page in one direction, so a column of marks seen together rolls with one rhythm. On mount each tile's motion over the sea's 36-second loop is baked into
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
- Chop (the base): each tile bobs on its own — three sines of 1.8–4s whose
  frequencies and phases are hashed from the tile's position — so tiles in one
  mark are unrelated.
- Sweeps (strength 0.55 of the height): five times per 36s loop, at irregular
  times and in varying directions (down, down-left, down-right, diagonal), a bright
  band crosses the page over 2.8s and lifts every tile it passes, fading in and
  out so it never pops. In a sidebar it rolls through the column row by row.
- Every period and sweep repeats within 36s, so the field loops seamlessly. One
  sea for the page: a tile's height depends only on its page position; in a list
  the sea between rows is skipped ("stitched", `rowPitch = 28`).

### How the field was found

The owner's target: watched alone, a tile should look like it bobs at random;
squinting at all marks, a wave should now and then roll through them in one
direction. Two earlier fields missed it in opposite ways, measured over 24
stitched rows (within-mark spread: mean standard deviation of the nine tiles;
rhythm: correlation of whole-mark brightness between adjacent rows):

| Field | Within-mark spread | Adjacent-mark rhythm | Seen as |
|---|---|---|---|
| two short plane waves | 0.26 | −0.83 | marks in antiphase, each running on its own |
| four long waves | 0.06 | 0.71 | all nine tiles of a mark moving as one block |
| short ripples + long swells | 0.21 | 0.49 | a continuous texture, never random-looking |

Continuous waves always make neighbouring tiles related, so a lone tile never
looks random. Separating the two layers does: between sweeps the nine tiles of a
mark correlate 0.06, and during a downward sweep whole-mark brightness peaks row
after row, about eight rows a second, rising ~8σ above the chop. Tests pin all
three: tiles independent between sweeps (fails when every tile shares one seed),
sweep peaks strictly in row order (fails with sweeps off), and a whole mark
almost never blanking.

## Implementation choice

| Option | Result |
|---|---|
| rAF loop writing styles (the prototype) | Rejected: per-frame main-thread work and repaint, the cost the spinner fix removed. |
| CSS keyframes with per-tile `animation-delay` | Rejected: CSS animations start when an element mounts, so marks mounted at different moments would sit on different seas. |
| Two nested sine layers per tile (first version) | Replaced: a product of two fixed-direction sines cannot express per-tile randomness or intermittent sweeps. |
| **Bake each tile's height over the loop into one keyframe animation, `startTime = 0`** | Chosen: any periodic field, compositor-played, aligned to the document timeline regardless of mount time. |

Each tile samples the field 10 times a second over the 36s loop (361 keyframes,
linear between samples; the fastest bob still gets 18 samples per cycle).
Baking costs a few thousand sine evaluations per mark at mount and nothing per
frame.

`prefers-reduced-motion` and engines without `Element.animate` render the grid
still. Superellipse tiles are available through CSS `corner-shape`
(Chromium 139+, Electron 39 ships 142).

## Tuning surface

`UI/WorkingGrid` in Storybook exposes every parameter as a control (shape,
brightness, scale mode, minimum and maximum size, gap, sweep strength, stitching) and
a `SidebarSimulation` story at production geometry: 28px rows, the trailing
status slot that swaps to Archive on hover, waiting and unread marks beside
working ones.

## Verification

- `tests/working-grid.test.tsx`: the sea loops seamlessly; stitching makes
  consecutive rows continuous; tiles bob independently between sweeps, a downward
  sweep reaches rows in order, and a whole mark almost never disappears (each
  checked against a field that should fail it); each of
  the 9 animations targets HTML, touches only `transform`/`opacity`, is a seamless
  loop pinned to `startTime = 0`, stays within `minScale`–`maxScale`, and is
  cancelled on unmount; reduced motion stays still; the sidebar end slot shows the
  grid while working.
- Rendered in Storybook (`UI/WorkingGrid`, `Components/LodySidebar` → All sessions
  working) and inspected by screenshot.
- Not done: a renderer CPU / layer trace in the packaged Electron app with many
  sessions running. That is the check to run before widening the grid to other
  surfaces.
