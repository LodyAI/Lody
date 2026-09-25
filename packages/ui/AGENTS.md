# `@lody/ui`

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Base UI + StyleX library that `packages/components/src/ui` migrates into one
component at a time. Consumers compile its source through `@stylexjs/unplugin`
with this package's `stylex-options.ts`.

- Package styles use StyleX: no Tailwind, `cn`, `cva`, `tailwind-merge` or
  `@source` scanning here. Component props own visual variants, sizes, tones and
  shapes. A caller's `className` may carry layout or interaction constraints,
  never the deleted component's visual design.
- Depends on React, `@base-ui/react` and `@stylexjs/stylex` only; never on
  `@lody/components`, `@lody/platform` or a cloud package.
- No border token exists. Edges are wells, raised shadows, elevation shadows
  and the focus ring. Read `src/tokens/RULES.md` before adding a token or style.
- A focus or invalid ring is a 2px `box-shadow` composed with the control's own
  shadow, never an `outline`: the shell resets every outline with `!important`,
  which no layer order overrides. A control whose edge changes with its state
  restates the ring; CSS cannot append to a box-shadow.
- Checkbox, Radio and Switch render a real `<button>` through Base UI's
  `nativeButton`, so `:disabled`, `:focus-visible` and a `<label>` reach them.
- Controls in the field family read validity and disabled from `Field.Root`
  through Base UI's state callback on `className`, never a prop of their own. The
  invalid ring follows `aria-invalid`, so it and what a screen reader announces
  are one fact; `src/field/invalid.ts` owns it — StyleX has no attribute
  selector.
- `NumberField` and `PasswordInput` join the field family. **A number is a
  range, not digits in a box**: the root clamps and returns `number | null`, and
  its input states the `aria-invalid` Base UI omits. A secret's shell is the
  input's own `render`, so `Field.Root` reaches the eye too; `Field.Item`
  orphans the label.
- A trigger reads `field` and the list it opens reads `popup`: different rungs,
  and the list's vocabulary is a menu's, not an input's. `src/popup/surface.ts`
  holds what floating parts share, as `src/field/well.ts` does for controls and
  `src/dialog/surface.ts` for modals.
- `Select.Value` resolves its text from `Select.Root items`, never the rows: a
  caller whose row text differs from its value states the list on the root too,
  or the trigger names the raw value (`test/select.test.tsx`).
- Every floating part's `Content` assembles Base UI's portal, positioner and
  popup, taking the positioning props outside. They mount into the nearest
  `PopupContainerProvider` on the absolute strategy: a container centred with
  `translate` contains `fixed` descendants.
- `Menu` is the dropdown; `ContextMenu` and `Menubar` restate only the way in
  and re-export its rows. A menu reads `popup` and replaces one declaration,
  `--anchor-width`; surface and rows come from `src/popup/surface.ts`.
- Whatever holds a glyph gives it a box, because this package's glyphs state
  100% and StyleX has no descendant selector: a menu row's, a badge's, an
  avatar's, an icon-only `Button`'s. A caller's icon states 100% too; a
  checkbox row's box holds its mark only.
- Every trigger here is Base UI's, unstyled: a surface opens a menu, popover or
  modal with what it had there, `render={<Button …/>}`. Post-close focus is the
  product's, as `finalFocus`.
- `Popover` reads `popup` too and replaces five of a list's declarations;
  `test/popover.test.tsx` names them and pins them.
- Dialog, AlertDialog and Drawer are one family on the modal rung sharing
  `dialog/surface.ts`; only their way in and dismissal differ. An outside press
  does not answer an alert dialog; Escape does. `Content` names its panel to
  `PopupContainerProvider` in **state, not a ref**: React attaches a child's
  refs first, so a popup mounting in the same commit lands on the body.
- There is no `Sheet`: a panel arriving from an edge is Base UI's `Drawer`, whose
  viewport lays it out so the panel's `transform` carries the drag. `side` is
  the writing direction's edge, `inset` the second axis.
- `Tooltip` is the one floating part not reading `popup`: the ladder inverts
  it, `label` under `shadow.medium`. Base UI makes it visual-only — no
  role, no `aria-describedby` — so every trigger states its `aria-label`.
- Tabs, Accordion and Collapsible are one `disclosure` family sharing
  `disclosure/surface.ts`. `Tabs.List` draws its own indicator and states the
  size once for every tab; a revealed panel's padding rides on a child: Base UI
  animates a `scrollHeight`, which counts it.
- Alert, Toast, Progress, Skeleton and Spinner are one `feedback` family. A tone
  is a tint and a mark, never a fill — mark in `tone.ts`, tint in `surface.ts`;
  `disabled` is Base UI state. A Spinner's turn rides an HTML wrapper, not
  svg: svg animations can't composite at DPR≠1 (crbug 1186312).
- `Table` and `Pagination` are one `table` family. **A column is stated once**:
  `Table` takes `columns` and owns width, ordering, selection (a `Checkbox`,
  never `aria-selected`), the empty row's span, the sticky head and the narrow
  stack. `table/parts.tsx` is the element layer. A
  table draws no surface: `border-collapse: separate` lets its line, head and
  row ring be box-shadows.
- Toggle, ToggleGroup and Toolbar are one `toggle` family; a Toggle is not a
  Switch (no name, no `Field.Root`, no validity). **On is the well, not the
  accent**: a well holds a stored value as accent; this rests on nothing. A
  set is no `Tabs` strip — two can be on at once, so no track — and a bar draws
  nothing, existing to be one tab stop.
- Card, Badge and Separator answer "what is an edge?": a card's is its shadow
  (Dialog's parts, no nesting; `interactive` only marks it pressable), a badge
  is on **no rung** — tone a film, word halfway to ink — and a `Separator` _is_
  the one allowed line: no token group, announced, no margin.
- Avatar and Kbd stand for something outside the interface, so both take a
  gray. **An avatar's rung picks its letters**; its box is a ceiling too, or a
  flex minimum widens a 16px circle. Identity colour is a `style`. A `Kbd` is
  never a menu row's shortcut; `Tooltip.Content`'s `kbdOnInvertedTheme` inverts
  a cap on a chip.
- A forced palette travels to a portalled popup: `ThemeRoot` publishes its mode
  and `Content` re-declares it on the positioner, since a popup mounts outside
  the subtree declaring it — a light panel would otherwise open a dark list.
- A part the shell may ring states no edge (`box-shadow: none`,
  `outline: none`): it rings any focused `[tabindex]`. `Combobox.Empty`
  stays mounted for its live region, collapsing through `:empty`.
- Files calling `defineVars`, `createTheme` or `defineConsts` end in
  `.stylex.ts`. Their arguments are object literals; the compiler cannot
  evaluate helpers. Vars are imported by a specifier ending in `.stylex`,
  never via a barrel.
- Component tokens live beside the component as
  `<name>/<name>.tokens.stylex.ts` and reference semantic tokens or literal px.
  One pointing at a semantic colour also belongs in that file's `createTheme`
  palette theme and in `componentPaletteThemes` (`src/theme/theme.tsx`): a
  custom property declared only at the root keeps the root palette in a themed
  subtree. A family shares one group (`field` the label, every control and
  their messages; `popup` the lists they open), not one per component.
- `src/gallery` is the token board: a new token, variant, size, tone or shape
  lands with its entry, read off the rendered node.
  `test/gallery.test.tsx` fails when a token has no entry. **A sample that is a
  rung needs a different rung under it**: the panel is the card rung, and in
  dark region and card are one value. No test sees this — open the board.
- `corner.shape` goes with every radius except `radius.full` and ringed
  corners — both `corner.round`: spread shadows can't parallel-offset a
  superellipse; round is the non-Chromium fallback.
- A Radix file in `packages/components/src/ui` is deleted when its in-repo
  callers reach zero; private consumers sync on typecheck.
