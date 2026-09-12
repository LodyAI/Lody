# `@lody/ui`

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Base UI + StyleX component library that `packages/components/src/ui` migrates
into one component at a time. Source-consumed; consumers compile it through
`@stylexjs/unplugin` configured with `stylex-options.ts` from this package.

- Package styles use StyleX: no Tailwind, `cn`, `cva`, `tailwind-merge`, or
  `@source` scanning inside this package. Component props own visual variants,
  sizes, tones, and shapes. A plain `className` pass-through may carry caller
  layout or interaction constraints during staged migration; do not use it to
  reconstruct the deleted component's visual design.
- Depends on React, `@base-ui/react` and `@stylexjs/stylex` only. Never on
  `@lody/components`, `@lody/platform`, or any cloud package.
- No border token exists. Edges are wells, raised shadows, elevation shadows
  and the focus ring. See `src/tokens/RULES.md` before adding a token or a
  component style.
- A focus or invalid ring is a 2px `box-shadow` composed with the control's own
  shadow, never an `outline`: the product shell resets every outline with
  `!important`, which no layer order overrides. A control that changes its edge
  with its state restates the ring with it; CSS cannot append to a box-shadow.
- Checkbox, Radio and Switch render a real `<button>` through Base UI's
  `nativeButton`, so `:disabled` and `:focus-visible` reach them the way they
  reach an `<input>` and a `<label>` can point at them.
- Controls in the field family read validity and disabled from `Field.Root`
  through Base UI's state callback on `className`. A control does not take its
  own `invalid` or `disabled` colour prop. The invalid ring also follows
  `aria-invalid`, which `Field.Root` renders onto the control, so the ring and
  what a screen reader announces are one fact; `src/field/invalid.ts` owns that
  reading. StyleX cannot express an attribute selector, so it is read in JS.
- A trigger reads `field` and the list it opens reads `popup`: different rungs,
  and the list shares its vocabulary with a menu rather than an input.
  `src/popup/surface.ts` holds the appearance the floating parts share, the way
  `src/field/well.ts` holds the controls' and `src/dialog/surface.ts` the modals'.
- `Select.Value` resolves its text from `Select.Root items`, never from the rows.
  A caller whose row text differs from its value states the list on the root as
  well, or the trigger names the raw value; `test/select.test.tsx` pins both.
- Every floating part's `Content` assembles Base UI's portal, positioner and
  popup so a caller writes contents rather than plumbing, and takes the
  positioning props on the outside. They mount into the nearest
  `PopupContainerProvider`, and switch to the absolute positioning strategy when
  they do: a host container that centres itself with `translate` is the
  containing block for `position: fixed` descendants, and a viewport-anchored
  popup inside one lands at its own offset.
- `Menu` is the dropdown menu; Base UI has no separate part for one and a second
  name would be a second thing to keep in step. `ContextMenu` and `Menubar`
  restate only the way in and re-export `Menu`'s rows. A menu reads `popup` and
  replaces exactly one of a list's declarations, its `--anchor-width`; the rest
  of the surface, and every row, is shared through `src/popup/surface.ts`.
- A menu row's leading box sizes the glyph in it; a caller's icon must fill the
  box rather than take its library's default, because StyleX has no descendant
  selector to reach it with. A checkbox or radio row's box holds its mark only —
  Base UI unmounts the mark while unticked, so an icon there would move as the
  row toggles.
- Every trigger here is Base UI's, unstyled: a surface opens a menu, a popover or
  a modal with whatever it already had there, through `render={<Button …/>}`.
  Post-close focus is the product's policy, passed as `finalFocus`.
- `Popover` reads `popup` too and replaces five of a list's declarations: the
  anchor width, the row inset, and the three that make type a control's rather
  than prose. `test/popover.test.tsx` pins that as a count.
- Dialog, AlertDialog and Sheet are one family on the modal rung sharing
  `dialog/surface.ts` and the `dialog` group; only the way in and what may
  dismiss them differ. An outside press does not answer an alert dialog, but
  Escape does. `Content` names its own panel to `PopupContainerProvider` and
  holds it in state, not a ref: React attaches a child's refs before its
  parent's, so a popup mounting in the same commit reads null and lands on the
  body — the one case that mechanism exists to prevent.
- `Tooltip` is the one floating part that does not read `popup`: the ladder
  inverts it, `label` under `shadow.medium`. Base UI makes a tooltip visual-only
  — no role, no `aria-describedby` — so every trigger states its own
  `aria-label`; a migrated caller whose only name was its tooltip has no name.
- A forced palette travels to a portalled popup. `ThemeRoot` publishes its mode
  and `Content` re-declares the palette on the positioner, because a popup is
  mounted outside the subtree that declares it and would otherwise inherit the
  document's palette — a light panel on a dark page would open a dark list.
- A part on the floating or modal rung declares its own edge, which is no edge:
  the product shell rings any focused `[tabindex]` through a zero-specificity
  `:where()` rule, and Base UI focuses the highlighted row and the open panel, so
  both state `box-shadow: none` / `outline: none`. `Combobox.Empty` stays mounted
  so a screen reader has a live region and collapses through `:empty`; hiding it
  takes the region out of the tree.
- Files that call `defineVars`, `createTheme` or `defineConsts` end in
  `.stylex.ts`. Their arguments are object literals; the compiler cannot
  evaluate helpers. Vars are imported from that file by a specifier ending in
  `.stylex` (`@lody/ui/tokens/colors.stylex`), never through a barrel.
- Component tokens live beside the component as
  `<name>/<name>.tokens.stylex.ts` and reference semantic tokens or literal px.
  A component token that points at a semantic colour also belongs in that file's
  `createTheme` palette theme, listed in `componentPaletteThemes` in
  `src/theme/theme.tsx` so `ThemeRoot` applies it with every forced palette; a
  custom property declared only at the document root keeps the root palette
  inside a themed subtree. A family shares one group (`field` covers the label,
  Input, Textarea, Checkbox, Radio, Switch, the Select and Combobox triggers,
  help and error; `popup` covers the lists they open) rather than one group per
  component.
- `src/gallery` is the visual reference for the package. A new token, variant,
  size, tone or shape lands with its board entry in the same change, and the
  board reads sample values back off the rendered node instead of repeating a
  literal. `test/gallery.test.tsx` fails when a token has no entry.
- `corner.shape` is applied wherever a radius is applied, except on
  `radius.full`: a pill or a circle takes `corner.round`, because a squircle at
  that radius is a superellipse rather than a stadium. Round corners outside
  Chromium are the accepted fallback.
- A Radix file in `packages/components/src/ui` is deleted when its in-repo
  callers reach zero; private consumers sync on typecheck.
