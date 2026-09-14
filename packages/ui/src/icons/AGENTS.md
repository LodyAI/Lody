# `@lody/ui` icons

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

The set is drawn here and never taken from a package: `@lody/ui` may depend on
React, Base UI and StyleX and nothing else. `registry.ts` is the drawing,
`icon.tsx` decides which layers a variant draws, `stateful.tsx` holds the icons
with two states, and `index.ts` names each one as a component.

## The grid

- 24 canvas, 20 live area (2 to 22), a 1.5 stroke with round caps and joins,
  2px corners on containers and 2px nodes for the git family. Strokes sit on .5
  coordinates so 1.5px is crisp at 1x. Nothing crosses the live area, including
  what a state swings out to.
- A family shares one skeleton: the chat family one bubble, the file family one
  folded sheet, the git family the same two node columns, and `sidebar`,
  `terminal`, `monitor` and `image` the same 2px container. A new member takes
  its family's skeleton before it takes a better idea.
- An icon states no size and no colour. It fills the box it is given and
  inherits `currentColor`, so the part holding it owns both — the same contract
  the package's glyphs have.
- Two names may be one drawing (`send` and `arrow-up`, `pin` and `pin-off`).
  State the path once as a module const; a name is a meaning, not a picture.

## Variants

A variant is a layer treatment of one drawing, never a second drawing. `marks`
is the outline; `layers` is what the fills are built from — `mass` (closed, the
back), `mid`, `front`, `detail` inside the mass, `outer` outside it, `dots`.

- Outline draws the marks. Duotone adds `mass` at 18%. Glyph fills everything
  and cuts `front` and `detail` **through a mask**, so the cut is a hole and the
  icon sits on any surface; a painted cut is correct on one background only.
  Bulk is `mass` at 35%, `mid` at 55% and `front` at 100%, with no outline.
- **A drawing a fill would cost its meaning takes no layers.** `folder-plus`
  and `users` have none: a cross drawn on a 100% front panel is currentColor on
  currentColor and what is left is `folder`, and half a person as a stroke
  beside a filled one is two fragments off a silhouette. `folder-open` and
  `user` were already outline-only for the same reason.
- **What a stroke's join rounds, a mass rounds itself.** A fill has no join, so
  a spike the outline hides comes back in glyph and bulk: the bell's flange met
  its mouth at 39 degrees and grew horns until the side was made to arrive
  vertically and turn through a 0.7 corner.
- `outer` is an appendage the silhouette needs — an antenna, a bell's nub, a
  monitor's foot — not a second subject. It is drawn in every variant and never
  cut, which is why `dots` drawn the same way disappear on a glyph.

## Two states

A stateful icon is one `<svg>` whose parts are functions of one registered
number, `--lody-icon-t`, which CSS transitions.

- Only transform, opacity and dash offset move, and no path morphs, so **both
  ends are the static drawing** and a host without property transitions snaps.
  `prefers-reduced-motion` sets the duration to zero.
- Where a state moves the whole drawing, read the path from `ICONS` rather than
  restating it; `test/icons.test.tsx` holds `BellRingIcon` to that. Two of this
  set's drawing bugs were a stateful icon and a static one drifting apart.
- **Never `scaleX` a stroke.** A horizontal scale leaves the thickness alone and
  squashes the round caps, so the state lands on a different drawing. Retract a
  stroke with its dash instead: a dash at zero length is a round cap and nothing
  else, which is a dot. A uniform scale grows a stroke without changing it.
- A state that swings the drawing has to keep it on the canvas. The bell pivots
  on its nub 16 units from its mouth, so its angle is 12 degrees and not 14.

## Adding one

Draw it, add the name to its family in `ICON_FAMILIES`, export it from
`index.ts`, and **open the playground** — `pnpm --filter @lody/ui playground`.
The tests pin the grid, the accessibility contract and the four treatments;
they cannot see that a drawing reads. Check it at 16 and 20, on the accent rung
where a glyph's mask shows, and in bulk where a 100% layer hides what is under
it. The board in `src/gallery` gets no entry: an icon adds no token.
