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
transitions, with no path morphing. The set is in the package with its board
and tests; whether it becomes the product's icon language, and which product
callers migrate, is not decided here.

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

**One grid, in the package.** 75 icons on a 24 canvas with a 20 live area, 1.5
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
`glyphs.tsx` already has. The board is the holder and shows each icon at 16, 20,
24 and 32.

**A stateful icon moves by one number.** `--lody-icon-t` is registered with
`CSS.registerProperty` as a `<number>` so CSS can transition it; every part of
the icon is a function of it — the sidebar's divider slides 3 units, its dashes
scale out, a chevron rotates 180°, a check draws through `pathLength` and dash
offset, a bell swings by `sin` and comes back to rest. Only transform, opacity
and dash offset move, no path morphs, so at rest each state is the static
drawing and a host without property transitions snaps to the right state.
`prefers-reduced-motion` sets the duration to zero. Nine icons ship this way;
the pattern covers displacement, rotation, draw-in, fill-and-pop and crossfade.

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
are the same markup with one number changed. `test/gallery.test.tsx` renders the
board with the new section. jsdom applies none of the CSS, so the rest was seen
on the static Storybook board in Chromium, both palettes: every icon in its
24px box, the four sizes, the four treatments with transparent glyph cuts, and
the two-state pairs. The transition was driven live: `--lody-icon-t` resolves
as a registered number, the sidebar divider computes to `translateX(-3px)` in
the collapsed state, and flipping the property interpolates it over ~330 ms
(`-1.56 → -2.45 → -2.82 → -2.97 → -3`). The static build itself needed a larger
Node heap and does not link the StyleX stylesheet on the gallery story; the
check injected `assets/600-*.css` by hand, a harness defect separate from this
change.

## Deliberately not done

No product caller migrates; `glyphs.tsx` keeps its 16 grid until a caller does.
No optically corrected 16px family. No `Spinner` from `refresh`: a turn is one
transition, a spinner is an animation and already exists. The other exploration
of a wider family in this repository's notes is a separate proposal.
