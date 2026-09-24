# Replace the sidebar working spinner with a shared-sea tile grid

Status: implemented
Translation: current

[中文](2026-09-24-sidebar-working-grid.zh.md)

## Abstract

The sidebar marked a running session with a rotating `Loader2` arc, which reads
as "loading" rather than "an agent is working", and five or six of them spin
independently down the list. The mark is now `WorkingGrid`, a 3×3 grid of tiles
that rise and sink with one sea shared by the whole page: long waves from several
directions take turns dominating, so the flow keeps turning, and each tile
samples the sea at its own page position, so neighbouring rows move as one body
of water. On mount each tile's motion over the sea's 36-second loop is baked into
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
  Tiles are at most 0.8 of their cell and shrink to 0.45 of it in a trough;
  opacity follows the sea down to 0.35.
- The sea: four plane waves heading down-right, down, slightly down-left and
  down-left, 12–15 cells long (× wavelength 1.3), periods 2.25–3.6s. Each wave's
  strength swells and fades over 12–36s, out of step with the others, so about
  two dominate at a time and interfere, and the dominant direction keeps
  shifting. Every period divides 36s, so the field loops seamlessly.
- One sea for the page: a tile's height depends only on its page position. In a
  list the sea between rows is skipped ("stitched", `rowPitch = 28`), so a crest
  leaving one mark enters the next.

### Why the first version looked disjointed

The first shipped field was two fixed-direction waves 3.2 and 4.4 cells long.
Stitched sidebar marks sit 3 cells apart, so neighbours were almost in
antiphase: over a loop the centre tiles of adjacent rows correlated −0.55, and
every mark looked like it ran on its own. Longer waves fix that but risk a single
trough covering all nine tiles. Measured over 40 stitched rows:

| Wavelength × floors | Adjacent-row correlation | Time a whole mark is below ¼ presence |
|---|---|---|
| first version (two short waves) | −0.55 | — |
| 1.0, min 0.3 / opacity 0.16 | 0.54 | 9.1% |
| **1.3, min 0.45 / opacity 0.35** | **0.71** | **0.1%** |
| 1.6, min 0.45 / opacity 0.35 | 0.79 | 0.2% |

Two tests hold the default between those failure modes: adjacent rows must
correlate above 0.6 (fails at wavelength 0.6), and the brightest tile of a mark
may fall below 0.15 for under 1.2% of the loop (fails at 2.4).

## Implementation choice

| Option | Result |
|---|---|
| rAF loop writing styles (the prototype) | Rejected: per-frame main-thread work and repaint, the cost the spinner fix removed. |
| CSS keyframes with per-tile `animation-delay` | Rejected: CSS animations start when an element mounts, so marks mounted at different moments would sit on different seas. |
| Two nested sine layers per tile (first version) | Replaced: a product of two fixed-direction sines cannot change direction or weight over time. |
| **Bake each tile's height over the loop into one keyframe animation, `startTime = 0`** | Chosen: any periodic field, compositor-played, aligned to the document timeline regardless of mount time. |

Each tile samples the field 10 times a second over the 36s loop (361 keyframes,
linear between samples; the fastest wave still gets over 20 samples per cycle).
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
  consecutive rows continuous; adjacent rows move together and a whole mark almost
  never disappears (both checked against a wavelength that should fail); each of
  the 9 animations targets HTML, touches only `transform`/`opacity`, is a seamless
  loop pinned to `startTime = 0`, stays within `minScale`–`maxScale`, and is
  cancelled on unmount; reduced motion stays still; the sidebar end slot shows the
  grid while working.
- Rendered in Storybook (`UI/WorkingGrid`, `Components/LodySidebar` → All sessions
  working) and inspected by screenshot.
- Not done: a renderer CPU / layer trace in the packaged Electron app with many
  sessions running. That is the check to run before widening the grid to other
  surfaces.
