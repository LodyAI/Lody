# UI icons: one grid, four treatments, and a number to move by

Status: proposed
Translation: pending

## Abstract

`@lody/ui` had a handful of glyphs drawn by hand for its own triggers and rows,
and `packages/components` had `react-icons` for brand marks plus several hundred
inlined `<svg>`s of no shared grid. This note proposes an original icon set for
the package, drawn on one 24 grid at a 1.5 stroke following Nucleo's drawing
conventions but none of its paths, and records three decisions that came out of
drawing it: a variant is a layer treatment of one drawing rather than a second
drawing; a glyph's cut-outs are a mask and never a painted panel colour; and a
stateful icon moves by a single registered custom property that CSS
transitions, with no path morphing. The set is in the package with its own
playground and its tests; whether it becomes the product's icon language, and
which product callers migrate, is not decided here.

## Problem

Three sources of icons, none on a grid the others share. `src/internal/glyphs.tsx`
draws nine glyphs on a 16 grid at a 1.6 stroke, because the package may depend
on nothing but React, Base UI and StyleX. `packages/components` uses
`react-icons` at sixteen sites, almost all for brand logos, and inlines an
`<svg>` in roughly four hundred files, each drawn to whatever its author had to
hand. A menu row's chevron and the sidebar's toggle are therefore two weights
of two strokes on two grids, and every new surface draws a third.

The user asked for an original set in the manner of Nucleo, then for the
intermediate treatments — the "black and grey" ones — and then for detail and
state: a sidebar that shows what is in it and whether it is open, with the way
between the two states animated.

## Decisions

**One grid, in the package.** 91 icons on a 24 canvas with a 20 live area, 1.5
stroke, round caps and joins, 2px corners on containers, 2px nodes for the git
family, strokes on .5 coordinates. A family shares one skeleton: the chat family
one bubble, the file family one folded sheet, the git family the same two node
columns. Drawn here for the reason the glyphs were: the dependency rule. The set
follows Nucleo's conventions — gear form, folder tab line, bell nub, robot face —
and copies no path; Nucleo is a paid library whose files were never in hand and
whose licence, as understood, forbids redistributing them in a public repository.

**A variant is a layer treatment.** The first draft had a second drawing per
treatment. The board showed that was wrong twice over: it doubled the paths to
maintain, and the "bulk" draft that dimmed the whole icon and painted the
details at full strength put a black line across a grey folder — a divider with
no meaning. So `registry.ts` gives an icon `marks` (the outline) and, where it
has depth, `layers`: `mass` (back), `front`, an optional `mid`, `detail` inside
the mass, `outer` strokes outside it, and `dots`. Outline draws the marks;
duotone adds the mass at 18%; glyph fills everything and cuts the details;
bulk is the mass at 35%, `mid` at 55% and `front` at 100% with no outline, so
the depth is the difference between fills. The cube that became `model` showed
the last rule: its edge line in bulk was a 100% stroke over a 35% face and stuck
out past the vertex; the three faces at three opacities are the edge.

**A glyph cuts through a mask.** The draft painted cut marks in the panel
colour, which is correct on exactly one background. The component builds an SVG
mask per glyph — `useId`, with React's punctuation stripped so it survives
`url(#…)` — so the cut is transparent. Strokes outside the mass (an antenna, a
bell's nub, a chip's pins) are drawn in every variant and never cut: they are
the silhouette.

**Icons state no size and no colour.** The rules give the box to whatever holds
a glyph; an icon fills it and inherits `currentColor`, the contract
`glyphs.tsx` already has. The playground is the holder and states every size and
colour it applies from the outside.

**The set's surface is a playground, not a board row.** The first draft put the
set in `src/gallery` as four more rows, and the gallery is reached through
`packages/components`' Storybook. That was wrong twice. The board's question is
"what is this token's value", answered once per token off the rendered node; an
icon has no token, and its question is asked once per drawing — find it, put it
at the size the surface uses, in that surface's colour, on the rung it will sit
on, and take it away as markup. Those are controls, not samples, and a row on a
board cannot carry them. And the set is `@lody/ui`'s, while Storybook belongs to
a package that only consumes it: looking at an icon should not require building
the product's component library. So `packages/ui/playground` is a Vite page of
its own — `pnpm --filter @lody/ui playground` — with search, a size slider from
12 to 64, the four treatments, the semantic tones, the four rungs (the accent
rung is where a glyph's mask shows, since the cut is a hole and the rung shows
through), a per-icon panel with the drawing enlarged on the 24 grid and
`copy svg`, and the stateful icons under a slow-motion switch. It is dev-only:
nothing in `playground/` is exported, and the package still depends on React,
Base UI and StyleX alone at runtime.

**A stateful icon moves by one number.** `--lody-icon-t` is registered with
`CSS.registerProperty` as a `<number>` so CSS can transition it; every part of
the icon is a function of it — the sidebar's divider slides 1.5 units and its
rows retract by their dash, a chevron rotates 180°, a check draws through
`pathLength` and dash offset, a bell swings by `sin` and comes back to rest.
Only transform, opacity and dash offset move, no path morphs, so at rest each
state is the static drawing and a host without property transitions snaps to
the right state. `prefers-reduced-motion` sets the duration to zero. Nine icons
ship this way; the pattern covers displacement, rotation, draw-in,
fill-and-pop and crossfade.

**Correction: the collapsed sidebar was drawn into a rail that could not hold
it, and scaled where it should have retracted.** As first drawn, the collapsed
state put its divider at 6.5, leaving a 3-unit rail; the two strokes bounding
that rail take 1.5 of it, so the marks inside had 1.5 units to live in and were
drawn 2 wide. They overlapped the frame on one side and the divider on the
other, and the icon read as three lumps rather than a rail — which is what
opening the playground showed. The animated state was wrong a second way: it
shrank the rows with `scaleX`, and a horizontal scale leaves a stroke's
thickness alone while squashing its round caps, so at t = 1 the marks were 0.8
wide against the static drawing's 2. The two ends of the transition were two
different drawings, against the rule stated above.

Both are redrawn. The divider collapses to 8.5, so the rail is 5 units and the
3.5 between its strokes holds one mark of 2 with 0.75 of air on either side.
The rows retract by dash instead: a dash shortened to zero length is a round
cap and nothing else, which is a dot, and the uniform scale carrying it from
1.5 to 2 grows the stroke without touching its shape. Two marks, not three —
at 2 wide a third leaves a 1-unit gap, and a size ladder shows three dots
smearing into one vertical stroke by 20px while two stay separate. The middle
row fades; the outer two become the marks at (6, 9.5) and (6, 14.5), which is
what `sidebar-collapsed` now draws.

**Correction: the bell was a tube, and its flange was a spike.** Drawn with an
11-wide dome over 6 units of straight side it was 14 across and 13 down, which
is not the proportion of a bell; the playground showed that too. The dome is 12
now and the side sweeps out to a mouth 16.4 across a 12.7-tall body.

The interesting part is the mouth. The first widening kept the flange — a
straight flare from the side to the mouth line — and made it bigger, and the
filled variants grew horns: the flare met the mouth at 39 degrees, and a
39-degree tip is a spike that `stroke-linejoin: round` hides in the outline and
a fill cannot. Rounding the spike is not available either, because a 0.8 radius
at that angle consumes 2.28 units of a 3.2-unit flare and there is no flange
left. So the flange is gone: the side arrives at the mouth vertically through a
curve, turns through a 0.7 corner, and the mouth is a line under it. The corner
is 90 degrees, which a fill can hold. This is the general form of the rule the
set already had for glyphs — **what the outline's stroke rounds, the mass has to
round itself**, since a variant is a treatment of one drawing and the fill has
no join to round.

Widening the bell also widened its swing: the mouth is 16 units from the nub it
pivots on, and at the old 14 degrees the corner furthest from the pivot put its
stroke 0.03 from the canvas. That is inside, and it is not a margin. The swing
is 12 degrees now, which leaves 0.42 and reads the same.

`BellRingIcon` no longer restates the path. It reads `ICONS.bell` — the bell
swings as one piece, so there is one drawing and the state only rotates it —
and `test/icons.test.tsx` holds it there. That is the guard the sidebar did not
have: both of these corrections are a stateful icon and a static icon drifting
apart, and where a state moves the whole drawing the drift is now impossible.

**Sixteen more drawings, picked from what the product already reaches for.**
`packages/components` imports 239 distinct icons from `lucide-react` across 295
files, 2138 usages. Collapsed onto the drawings that would serve them, the set
covered 78% of that before this change; the sixteen added here — `monitor`,
`alert-circle`, `users`, `circle`, `shield-alert`, `folder-plus`, `arrow-up`,
`mail`, `wrench`, `undo`, `quote`, `save`, `image`, `pin-off`, `fork` and
`pull-request-closed` — take it to 91%. `monitor` alone answers 52 usages, which
is what a product about machines looks like from the icon layer.

Three of them were redrawn after the first pass, and all three failed the same
way — a shape that reads at 120px and not at 20. `quote` as a block with the
tail notched out of a corner is a pair of counters by 20px; it is a hook now.
`pin-off` broken into fragments the way `eye-off` breaks is not a pin; the pin
stays whole and takes the line across it, because a pin has no centre for a
line to be mistaken for. `pull-request-closed` had its cross floating two units
clear of the branch it closes, so it read as two drawings.

`package` was dropped from the batch rather than drawn: a box with a lid is
`archive` and an isometric one is `model`. And `folder-plus` and `users` lost
their layer models on the same inspection that produced the rule above — the
playground's bulk column is where both showed.

## Alternatives

An icon package — Lucide, Phosphor, Tabler, Iconify through `unplugin-icons` —
was surveyed first and is the right answer for a product that does not draw.
Rejected here because the package's dependency rule forbids it and because the
product wants a set of its own; brand marks stay with `react-icons/si`, which
none of the drawn sets carry. A chip was drawn for `model` and rejected: it is
the hardware, not the model; twelve alternatives were boarded and the cube won
on the mental model OpenRouter, Raycast and Vercel AI have already trained. A
brain was drawn and rejected on sight.

## Trade-offs and limits

The 16px rendering is the 24 grid scaled, not an optically corrected small size;
`worktree` and `model` are the first to show it. Path morphing would give a
truer play-to-pause than a crossfade, but only in Chromium; the crossfade is the
same everywhere. `sin()` in `calc()` and registered-property transitions need
Chromium, Safari 16.4 or Firefox 128, which the Electron host meets; older
hosts snap. The mask makes each glyph carry its own `<mask>` element, which is
more markup than a painted cut. `registry.ts` is generated from the design
board rather than written by hand, and the board is a `/tmp` file, not a
repository artifact; a future change edits the registry directly.

## Verification

`test/icons.test.tsx` pins the registry's shape and its stay on the grid, the
accessibility contract, the four treatments, mask uniqueness, that outer strokes
survive a glyph, that bulk has no outline, and that a stateful icon's two states
are the same markup with one number changed. The board in `src/gallery` has no
icon section and `test/gallery.test.tsx` is unchanged: an icon adds no token, so
the test that fails on a token without an entry has nothing to say about one.

The drawings themselves were seen earlier on the static Storybook board in
Chromium, both palettes — every icon in its 24px box, the four sizes, the four
treatments with transparent glyph cuts, the two-state pairs. That check reported
the sidebar divider computing to `translateX(-3px)`, which was the measurement
of the drawing corrected above and no longer holds; it is `-1.5px` now. Reading
a number off a broken drawing and recording it as evidence is what that check
did wrong: it proved the property was transitioning, not that the icon was
right.

The redrawn sidebar was checked in the playground in Chromium at 64px. The
animated state at t = 1 and the static `sidebar-collapsed` were screenshotted
and compared pixel by pixel: 825 ink pixels against 833, differing only by a
one-pixel fringe on every stroke in the same direction, which is a sub-pixel
crop offset rather than a difference in shape. The two marks land in the same
place in both. The transition was rendered at t = 0, 0.25, 0.5, 0.75 and 1: the
rows retract, the middle one fades, the caps stay round throughout, and no
sliver appears. A size ladder at 16, 20, 24, 32 and 48 decided two marks over
three. At 16px the rail is 2px wide and its marks are gone — the same limit the
expanded drawing already has there, and the reason this set still owes an
optically corrected small size.

## Deliberately not done

No product caller migrates; `glyphs.tsx` keeps its 16 grid until a caller does.
No optically corrected 16px family. No `Spinner` from `refresh`: a turn is one
transition, a spinner is an animation and already exists. The other exploration
of a wider family in this repository's notes is a separate proposal.

The playground does not scrub `--lody-icon-t` by hand. A stateful icon takes a
boolean and writes the number itself, and `Frame` states `style` after spreading
its rest props, so a holder cannot pass one in; slow motion is a duration
override on the host page instead. Making the number an input is a change to the
components, and was not made for a dev page.
