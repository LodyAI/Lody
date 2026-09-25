# UI number and password fields: a range that keeps its own limits, and a field built around its own value

Status: implemented
Translation: pending
PR: https://github.com/LodyAI/Lody/pull/831

## Abstract

`@lody/ui` had no control for a number, so seven product call sites wrote
`<Input type="number">` and then re-implemented the same three lines after it —
parse `event.target.value`, test `Number.isFinite`, clamp to a range — in four
different spellings, none of which can step a value or stop the arrow keys
leaving the range. The survey this work started from said Base UI had no number
field and that `Input` plus `type="number"` was the whole migration; reading
`@base-ui/react@1.7.0` shows it ships a complete `NumberField`, and a
`ScrollArea` the same survey also called missing. This note records the two
primitives that land — `NumberField`, wrapping that part, and `PasswordInput`,
the first control in this package with no Base UI primitive under it — and the
two gaps in the library underneath that each had to close: Base UI marks an
invalid number field `data-invalid` and never `aria-invalid`, so the ring was
the only sign it was invalid, and the one Base UI part that renders a `<div>`
carrying field state, `Field.Item`, opens a labelable scope that leaves an
outer `Field.Label` pointing at a control that does not exist. All seven number
call sites and all three password ones are migrated, `clampBudget` and the
Tailwind `ui/password-input.tsx` are deleted, and the board turned up a ring
defect older than this work: a focused adornment drew the app shell's own inset
ring inside the field's, on the Combobox chevron as much as on the new parts.

## Problem

Seven places in `packages/components` needed a bounded integer and each built
one out of a text control.

`<Input type="number">` is an `<input>` whose `value` is a string, so every one
of them re-derived the number:

- `settings/review-policy-setting.tsx` (three of them) shared a local
  `clampBudget(value: string, min, max, fallback)` that parsed, checked
  `Number.isFinite`, and clamped.
- `settings/appearance-setting.tsx` (two) and
  `mobile/mobile-appearance-settings.tsx` read `event.target.valueAsNumber`,
  guarded it with `Number.isFinite`, and passed it through a `normalize…`
  helper that clamps and rounds.
- `sessions/chat-share-image-dialog.tsx` used `Number.parseInt` and a
  `next > 0 ? next : 0` floor.

Four spellings of one idea. They are not *wrong* — each handles an emptied box
correctly, and the two outcomes they produce are each right for their field: six
keep the current value (the `Number.isFinite` guard skips the setter; `clampBudget`
returns its `fallback`) and the chat-share field floors to 0, which is what "never
collapse" means there. `normalizeConversationFontSize` does return the *default*
size for anything not finite, which would reset the setting the moment the box was
emptied, but the guard in front of it means it is never called that way. That is
the shape of the problem: four hand-written parsers, one of which is only correct
because of the guard standing in front of it.

None of the seven can be stepped, none clamps what a keyboard's arrow keys do
(the browser steps a native number input past `max` unless the form validates),
and none has a control a thumb can hit.

`packages/components/src/ui/password-input.tsx` was a different kind of gap: it
already wrapped `@lody/ui/input`, but the reveal beside it was Tailwind — an
absolutely positioned button over the input, with its own `hover:`,
`focus-visible:ring-1` and `disabled:opacity-50` — so a control that is half
this package's design system and half the one it replaces.

### The survey was wrong about what Base UI has

The inventory this task came with listed `NumberField` as "Base UI.Input has
primitive support — simple wrapper" and `ScrollArea` as "❌ Base UI has no
primitive support". Both are wrong, and the first would have produced a
component with none of the behaviour above. `@base-ui/react@1.7.0` ships:

```
number-field/{root,group,input,increment,decrement,scrub-area,scrub-area-cursor}
scroll-area/{root,viewport,scrollbar,content,thumb,corner}
```

`NumberField.Root` takes `min`, `max`, `step`, `largeStep`, `smallStep`,
`format`, `locale` and `snapOnStep`, clamps every stepped interaction, and
reports `onValueChange(value: number | null, …)`. That is the whole of what the
seven call sites were hand-writing, already written.

`ScrollArea` is left for its own change; see "Deliberately not done".

## Decision

Two primitives in the `field` family, reading the `field` token group, wearing
the family's well, ring, disabled opacity and size ladder. No new tokens: both
are built out of what `Input`, `Textarea` and `Combobox` already declare.

### A number is a range, not digits in a box

`NumberField` is a composition, like every other part of this family:
`NumberField.Root` owns the range, `NumberField.Group` is the well, and
`NumberField.Input` is the value inside it. The steppers are `Decrement` and
`Increment`, at 16px in the hint colour, and they sit inside the well the way a
`Combobox` chevron does rather than beside it — the ring then says "this field
has focus" instead of "this half of it does".

Without a `Group`, `NumberField.Input` is the whole control and takes the well
itself, which is the form a value somebody types once wants. That reads off a
context the group publishes, exactly as `Combobox.InputGroup` does, so the two
cannot disagree and draw two wells.

### `NumberField.Input` states its own `aria-invalid`

`packages/ui/AGENTS.md` already says the invalid ring follows `aria-invalid`
"so it and what a screen reader announces are one fact". Base UI's plain
`Input` honours that — inside a `Field.Root invalid` it renders
`aria-invalid="true"` — and its `NumberField.Input` does not; it renders
`data-invalid` and stops. Measured, on the same field:

```
Input            … data-invalid="" id="…" data-size="medium" aria-invalid="true"
NumberField.Input… data-invalid="" id="…" inputMode="numeric" type="text"      ← no aria-invalid
```

So the primitive states it, through the `render(props, state)` form of the prop
rather than a second source of truth: the same `state.valid` that decides the
ring decides the attribute. `render` is therefore not a prop of
`NumberFieldInput` — the input is the input.

It is left off while the field is disabled, because that is what Base UI's
`Input` does there too: a control nobody can reach is outside constraint
validation, and announcing it invalid is noise. Matching the sibling was worth
more than matching the rule literally, and the two agree everywhere a person
can act.

### A password field is built out of its own value

Base UI has no password part, so the question was what renders the well around
an input and a button.

`Field.Item` looks like the answer: it is the one part in the family that
renders a `<div>` and passes the full `FieldRootState` — `valid`, `disabled` —
to a `className` callback. It is wrong. It wraps its children in Base UI's
`LabelableProvider`, so the input inside it stops being the field's control and
a `Field.Label` outside it keeps pointing at the one that never arrived:

```
<label for="base-ui-_R_0_">Password</label>
  <div …>                       ← Field.Item
    <input id="base-ui-_R_5_" type="password">
```

A label that points at nothing is worse than the Tailwind component being
replaced. So the input stays the field's one control and builds the shell out
of its own `render(props, state)`: `props` go on the `<input>`, the shell is a
`<div>` around it, and the reveal beside it reads `state.disabled` from the same
call. That is what makes `Field.Root disabled` reach the eye — the Tailwind
version could not, because a sibling `<button>` has no way to know — and it is
why the label keeps working.

Whether the password is showing is the component's own state with no prop for
it. It is a glance, not a setting; a surface that could set it could store it,
and "show me the password" is not a thing to persist.

The reveal's two names are one `labels` prop, `{ show, hide }`, following
`Pagination`'s `labels` rather than the two flat props the Tailwind component
had — it is the only text in the control and it is never on screen.

### Alternatives considered

**Wrap `Input` with `type="number"`, as the survey proposed.** It is a smaller
diff and it is what the seven callers already have. Rejected: it hands back a
string, clamps nothing, and cannot be stepped, so every caller keeps the three
lines this work exists to delete.

**One `<NumberField min max value onChange steppers />` component instead of a
composition.** Fewer lines at each call site. Rejected: `Field`, `Select` and
`Combobox` are compositions, and the one component in this package that takes a
configuration prop instead — `Table`, with `columns` — does it because a column
must be stated once, which has no analogue here.

**Keep the reveal absolutely positioned over the input**, as the Tailwind
component did, and skip the shell. Simplest layout. Rejected: it is precisely
the arrangement that cannot read the field's disabled state, and the button
then overlaps the focus ring it is sitting inside.

**Give the steppers `cursor: pointer` and a `:disabled` opacity.** Rejected:
the shared adornment already dims with the shell, and a dimmed glyph inside a
dimmed shell is dimmed twice (0.45 × 0.45).

## What the board showed

The board is also where the one defect in this change was found, and it is
older than this change.

`well.adornment` — the 16px glyph box extracted here so `Combobox`'s chevron
and clear, the two steppers and the reveal are one thing rather than three —
set `outline: none` but said nothing about `box-shadow`. The app shell rings
any focused `[tabindex]` with an inset shadow, which `packages/ui/AGENTS.md`
warns about by name, so a focused adornment drew a second ring inside the
field's own:

```
reveal, focused (before) : rgba(91, 141, 239, 0.5) 0px 0px 0px 1px inset
chevron, focused (before): rgba(91, 141, 239, 0.5) 0px 0px 0px 1px inset   ← already shipped
reveal, focused (after)  : none
chevron, focused (after) : none
shell while the eye has focus: …inset, rgb(93, 141, 239) 0px 0px 0px 2px
```

The Combobox has had this since it landed; the shared style means one
declaration fixes all four.

Everything else read as intended, measured off the rendered nodes in both
palettes rather than copied from the tokens:

| | Lody Light | Vesper |
| --- | --- | --- |
| group / shell background | `rgb(232, 234, 237)` | `rgb(28, 28, 28)` |
| its edge | `rgba(25, 27, 31, 0.07) 0 1px 2px inset` | `rgba(0, 0, 0, 0.7) 0 1px 2px inset` |
| the value | `rgb(26, 27, 30)` | `rgb(255, 255, 255)` |
| a stepper and the eye | `rgb(150, 156, 166)` | `rgb(115, 115, 115)` |
| invalid | `…inset, rgb(206, 34, 45) 0 0 0 2px` | `…inset, rgb(255, 128, 128) 0 0 0 2px` |

The input inside either shell reads `box-shadow: none` — one well, not two —
the ladder measures 28 / 32 / 36 for both controls, and a disabled shell is
0.45. A box-shadow read in the same frame as the focus that caused it comes
back transparent at zero width, because the family transitions it; the readings
above were taken after it settled.

## Migration

Every in-repository caller moved, and two files are gone.

- **Seven number call sites**: `settings/review-policy-setting.tsx` (three),
  `settings/appearance-setting.tsx` (two),
  `mobile/mobile-appearance-settings.tsx`, `sessions/chat-share-image-dialog.tsx`.
  `clampBudget` is deleted — the primitive clamps — and the `Number.isFinite`
  guards with it. Each `onValueChange` ignores `null` rather than passing it to a
  normalizer, so the emptied box keeps the current value exactly as the guard it
  replaces did; the chat-share field keeps its `> 0` floor for the same reason,
  since typing (as opposed to stepping) is clamped on blur rather than on change.
  Every migrated field's behaviour is therefore the one it had. The three budget
  fields also gained the `aria-label` they never had; their rows label them
  visually only.
- **Three password files**: `login-page.tsx`, `pages/reset-password-page.tsx`,
  `settings/change-password-button.tsx` import from `@lody/ui/password-input`
  and pass `labels` where they passed `showPasswordLabel` / `hidePasswordLabel`.
- **`packages/components/src/ui/password-input.tsx` is deleted**, its in-repo
  callers being zero.

Each migration keeps the control's existing footprint: the same widths, the same
rungs, the bare input rather than the stepped group.

### Deliberately not done

- **No product surface uses the steppers yet.** They are the reason to prefer
  this primitive on a touch screen, and `w-20` / `w-24` rows have no room for
  two 16px controls and their gaps without being widened. Widening a settings
  row is a visual decision belonging to whoever owns that surface, and a
  migration that changes seven layouts is no longer a like-for-like swap. They
  are on the board, and the first surface that wants them costs two lines.
- **`Pagination`'s own `<Input type="number">` stays.** It is the same shape and
  the obvious next target, but its contract is different: it holds a draft
  string and commits on blur or Enter, because committing on change would
  navigate to page 1 while somebody types 120. `NumberField` has
  `onValueCommitted` for exactly this, but which interactions it fires on —
  Enter in particular — needs checking in a browser against the pager's
  behaviour, which is its own change with its own board reading.
- **`ScrollArea` stays on Radix in this change**, despite Base UI having a
  `ScrollArea` with a matching part list (`Root`, `Viewport`, `Scrollbar`,
  `Content`, `Thumb`, `Corner`) — `Content` being the part Radix lacks, which is
  what the wrapper's `[&>div]:block!` hack exists to work around. It has 13
  callers and eight custom props, and it is a family of its own.
- **`change-password-button.tsx` keeps the English reveal labels.** The
  component it replaced defaulted to English there too, so behaviour is
  unchanged; giving that dialog translated labels means inventing i18n keys,
  which belongs to whoever owns the copy.
- **`Resizable` stays on Radix.** Base UI has no equivalent.

## Verification

- `pnpm --filter @lody/ui test` — 274 tests across 23 files, all passing,
  including the 15 new ones in `test/number-field.test.tsx` and
  `test/password-input.test.tsx`, and the board's token coverage.
- `pnpm --filter @lody/ui typecheck` and `pnpm --filter @lody/components
  typecheck` are clean.
- `pnpm --filter @lody/components test tests/appearance-settings.test.tsx
  tests/review-policy-setting.test.tsx` — 7 tests passing, run with
  `NODE_ENV=development`, which React 19 needs for `act`.
- `pnpm lint`, `pnpm lint:i18n` and `pnpm check:public-boundary` pass.
- The board was driven in Chromium at both palettes: every value in the table
  above was read off the rendered node, the reveal was pressed and the value
  went `password → text → password` with the name following it, and the focus
  ring was confirmed to land on the shell from both the value and the eye.

Limits: the seven migrated surfaces were verified by type checking, by the
primitives' own tests and by the board, not by driving each settings row in the
running app. What is unverified there is the layout around the control — the
control itself is the one the board shows, since it is the same component. That
each migrated field answers an emptied box the way it used to is reasoned from
reading the old guards beside the new `null` checks, and the primitive's own
`null` behaviour is covered by its tests; no test drives an actual settings row
with an emptied box.
