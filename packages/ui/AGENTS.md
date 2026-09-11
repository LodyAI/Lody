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
- There is no generic border token. An interactive well or thumb that needs an
  identifiable boundary takes `colors.controlEdge` through an inset or outer
  shadow; separators remain row dividers only. See `src/tokens/RULES.md` before
  adding a token or a component style, and the
  [colour-contract decision](../../.agents/notes/implemented/architecture/2026-09-11-ui-semantic-color-contracts.md).
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
- A trigger reads `field` and the list it opens reads `popup`: the two are on
  different elevation rungs and the list shares its vocabulary with a menu, not
  with an input. `src/popup/surface.ts` holds the appearance both lists share,
  the way `src/field/well.ts` holds the one the controls share.
- `Select.Value` resolves its text from `Select.Root items`, never from the rows.
  A caller whose row text differs from its value states the list on the root as
  well, or the trigger names the raw value; `test/select.test.tsx` pins both.
- `Select.Content` and `Combobox.Content` assemble Base UI's portal, positioner,
  popup, list and scroll arrows so a caller writes rows rather than plumbing.
  They mount into the nearest `PopupContainerProvider`, and switch to the
  absolute positioning strategy when they do: a host container that centres
  itself with `translate` is the containing block for `position: fixed`
  descendants, and a viewport-anchored popup inside one lands at its own offset.
- A forced palette travels to a portalled popup. `ThemeRoot` publishes its mode
  and `Content` re-declares the palette on the positioner, because a popup is
  mounted outside the subtree that declares it and would otherwise inherit the
  document's palette — a light panel on a dark page would open a dark list.
- A part that renders on the floating rung declares its own edge. Base UI moves
  DOM focus onto the highlighted row, and the product shell rings any focused
  `[tabindex]` through a zero-specificity `:where()` rule; a row states
  `box-shadow: none` so no host can put a ring on it. `Combobox.Empty` stays
  mounted so a screen reader has a live region, so it collapses through `:empty`
  rather than being hidden — hiding it takes the region out of the tree.
- Files that call `defineVars`, `createTheme` or `defineConsts` end in
  `.stylex.ts`. Their arguments are object literals; the compiler cannot
  evaluate helpers. Vars are imported from that file by a specifier ending in
  `.stylex` (`@lody/ui/tokens/colors.stylex`), never through a barrel.
- Component tokens live beside the component as
  `<name>/<name>.tokens.stylex.ts` and hold component-specific dimensions or
  other values without a semantic equivalent. Component styles reference
  semantic colours and shadows directly: do not relay them through a second
  `defineVars` group, because inherited custom-property aliases resolve where
  they are declared and force every subtree theme to redeclare the relay. A
  family shares one dimensional group (`field` covers Input, Textarea,
  Checkbox, Radio, Switch and the Select and Combobox triggers; `popup` covers
  the lists they open) rather than one group per component.
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
