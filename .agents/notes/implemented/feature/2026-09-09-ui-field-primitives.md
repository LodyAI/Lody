# UI field primitives

Status: implemented
Translation: pending

## Abstract

`@lody/ui` had proven one component and a token set, but every remaining control
in `packages/components/src/ui` still reads Tailwind field concepts —
`input-border`, `input-field`, `input-placeholder`, `ring`, `muted` — that the
new token rules define no equivalent for. Migrating Input, Textarea and Label
one at a time across that gap would have let each control invent its own focus,
invalid and disabled colours, forking the token system the migration exists to
unify. This note records adding one `field` component token group and a Base UI
Field composition — `Field.Root` with `Field.Label`, `Input`, `Textarea`,
`Field.Description` and `Field.Error` — so those states are defined once and read
from the field rather than passed to each control, and writing the state mapping
into the token rules and the gallery. Building it exposed that the product
shell's `*:focus, *:focus-visible { outline: none !important }` suppresses every
outline-based focus ring, including the migrated Button's, so the field ring is a
box-shadow instead; Button still carries the suppressed outline and is not fixed
here. Every in-repo caller then moved onto the composition and the three Radix
and Tailwind files were deleted, which is what took the mapping from a board
into the product.

## Problem

The package exported `Button` and the theme; `packages/components/src/ui`
still owned every other atom. Proving "the Button pattern works" is not the same
as proving the contract for a control that has states.

The three files this pilot replaces read a vocabulary the new tokens do not have:

- `input.tsx`: `border-input-border`, `bg-input-field`, `text-input-foreground`,
  `placeholder:text-input-placeholder`, `focus-visible:ring-1 ring-ring`,
  `disabled:bg-muted disabled:opacity-60`
- `textarea.tsx`: the same set, plus `ring-offset-background` and an explicitly
  removed focus ring
- `label.tsx`: `@radix-ui/react-label` with `peer-disabled:opacity-70`

Three different disabled treatments (`bg-muted` + 60%, 70%, and the rules'
45%) and two different focus rings already existed in three files. Without a
decided mapping, each migrated control would add a fourth.

## Decision

**One token group for the family, not one per component.** `field` covers the
label, the control, the help text and the error, and the selects, checkboxes and
switches that follow. `button` stays separate because a button is not a field.
The alternative — `input`, `textarea` and `label` groups — is exactly the fork
this change exists to prevent: the same focus colour would be declared three
times and drift on the first redesign.

**Composition, not props.** `Field.Root` owns `name`, `disabled` and validity.
`Input` and `Textarea` read that state through Base UI's `className` callback and
pick their own classes from it. A control therefore has no `invalid` prop for a
caller to keep in sync with the field, and a label is associated with its control
without a hand-written `htmlFor`.

**Base UI throughout.** `Input` is Base UI's `Input`, which is `Field.Control`.
Base UI has no textarea part, so `Textarea` is the same `Field.Control` rendered
as a `<textarea>`; its props are typed from `<textarea>` and cast at the boundary,
because Base UI types the part as an `<input>` while forwarding element props
untouched. `Field.Label` replaces `@radix-ui/react-label`, which keeps the
package's dependency rule intact.

**State is read, not selected.** StyleX conditions are pseudo-classes,
pseudo-elements and at-rules; an attribute selector such as `[data-invalid]` is
not expressible. Base UI passes each part its own state to `className`, which is
both available and more direct than the data attributes it also emits. Focus
stays a CSS `:focus-visible` because a text control matches it for pointer focus
too, so it needs no React state.

Because StyleX keys a conditional value per condition, the invalid style restates
the focused case; otherwise an invalid control would flip back to the accent ring
the moment it takes focus.

### The mapping this closes

| Old Tailwind concept           | New token                                |
| ------------------------------ | ---------------------------------------- |
| `bg-input-field`               | `field.background` (`wellBackground`)    |
| `border-input-border`          | `field.well` (`shadow.inset`); no border |
| `text-input-foreground`        | `field.value` (`label`)                  |
| `text-input-placeholder`       | `field.placeholder` (`tertiaryLabel`)    |
| `ring-ring`                    | `field.ring` (`accent`), 2px             |
| `aria-invalid` colours         | `field.invalidRing` (`destructive`), 2px |
| `disabled:bg-muted opacity-60` | `field.disabledOpacity`, no colour swap  |
| input `text-base md:text-sm`   | `field.text` (13) at weight 500          |
| label `text-sm`                | `field.labelSize` (12) at weight 500     |

The control's own text follows the rules' control step — 13 at weight 500 with
`text.controlTracking` — rather than the prose weight a text field might
suggest. Dimensions that land on the space scale reference it (`space.2`,
`space.3`, `space.1.5`); the 10px inline padding of the 32px control is the one
literal, because the scale has no half step between 8 and 12.

### One type step for the whole ladder

The first cut sized control text by step: 12 at 28, 13 at 32 and 36, copying
what Button already did. That is wrong for this system, and the reason is the
system's own grammar rather than a typographic preference.

These rules give each channel one job and then forbid a second: `accent` marks
live state and is "never a button fill", `separator` divides rows and is "never
around a surface", disabled is an opacity and "not a color". Type size is
already spoken for the same way — controls 13, prose 14, labels and help 12 —
which is the type axis restating what the colour axis says with `label`,
`secondaryLabel` and `tertiaryLabel`: the thing, about the thing, a hint.
Density already has its own channels, the 28 / 32 / 36 height and the radius
that compensates for it. Letting size drive type as well is the channel
overloading the rest of the document bans.

The concrete collision: `field.textSmall` and `field.labelSize` both resolved to
`footnoteSize`, so at the 28 step a control's own value was typographically
indistinguishable from the label describing it, in a system whose first colour
rule is that those two are different things.

So the ladder is one step, and one token carries it: `field.text` and
`button.text` replace the per-size text tokens, because tokens whose values
happen to match are an invitation to drift apart later. Button's `small` moves
from 12 to 13 with it; a compact button and a dialog button are the same command
at two densities and should not disagree about how their label is set. Button's
`mini` keeps 12 and is left alone: at 24px it is not on the ladder the rules
define, and whether it belongs to the ladder or to the "16px things" the radius
rule mentions is a separate question this change does not settle.

## Discovered defect: the shell suppresses every outline ring

`packages/components/src/tailwind/index.css` ends its base layer with
`*:focus, *:focus-visible { outline: none !important; }`. Layer order is
`theme, base, stylex, components, utilities`, and for `!important` declarations
layer priority is reversed, so no ordering lets a StyleX rule win. Measured in
Chromium: a focused `Button` with `:focus-visible` matching reports
`outline-style: none` and no ring, and the field's first outline-based ring
behaved the same.

The field ring is therefore a `box-shadow` composed with the well's own inset
shadow, which the same base layer cannot override because its companion
`box-shadow` rule is not `!important` and StyleX sits in a later layer. This is
also the more robust mechanism, so it is now the rule for the package rather
than a local workaround.

Button follows. Its ring has to be restated per variant rather than added by a
second class, because CSS cannot append to a `box-shadow` list, and each variant
already owns a different edge: `primary` and `destructive` an ink highlight,
`secondary` a raised shadow, `ghost` and `link` nothing. Each variant therefore
declares its own `:focus-visible` value composing that edge with the ring, and
`button.ring` joins the palette theme so it resolves inside a forced subtree.

`:active` stays `none`, which is the press the rules describe — translate 1px
and drop the edge. Putting the ring there instead would draw it on an ordinary
mouse press, because a pointer press matches `:active` while `:focus-visible`
stays false. The cost is that a keyboard-held press loses the ring for as long
as the key is down, which is the smaller of the two errors.

The alternative was scoping the shell's global reset so it stops covering
`@lody/ui` primitives. It was rejected: that reset is the legacy focus system
for every remaining Radix control, the hashed StyleX classes give it nothing
stable to exclude, and narrowing it would resurface browser default outlines
across surfaces this change never touched.

## Other alternatives considered

- An `invalid` prop on `Input`. Rejected: two sources of truth for one state,
  and every caller would have to mirror `Field.Root` by hand.
- Keeping `@radix-ui/react-label` and styling it. Rejected: the package depends
  on Base UI only, and a Radix label carries no field state.
- Exporting a flat `Label` alongside `Field.Label`. Rejected: two names for one
  component. `Field.Label` covers the standalone case because this package makes
  it work without a root; see the correction below.

The gallery's own `Field` layout helper was renamed to `Sample` so the primitive
can own the name. `ThemeRoot` now applies a list of component palette themes
rather than a single one, which is the general mechanism the token gallery note
left open until a second colour-valued group existed.

## Verification

`pnpm --filter @lody/ui test` (24 tests) and `pnpm --filter @lody/ui typecheck`
pass. The tests cover label-to-control association, the error staying out of the
markup until the field reports it, invalid adding a class the valid control does
not have, `Field.Root disabled` reaching the control and the label, Input and
Textarea sharing the well styles rather than each defining one, a caller class
landing last, and the field palette theme riding along with both forced palettes.

The board was read in Chromium through Storybook at 1400px. Values read back off
the rendered nodes: heights 28 / 32 / 36 px, radius 8 at 28 and 10 at 32 and 36,
control text 13, well `rgb(232, 234, 237)` in Lody Light and `rgb(28, 28, 28)` in
Vesper with the matching inset shadow, disabled opacity `0.45`, and the invalid
ring `rgb(206, 34, 45)` and `rgb(255, 128, 128)`. Focusing a control by pointer
and by keyboard produced `… inset, rgb(93, 141, 239) 0px 0px 0px 2px` in Lody
Light and `rgb(255, 199, 153)` in Vesper, and an invalid control kept
`rgb(206, 34, 45)` while focused. The console reported no errors.

Limits: no test asserts a rendered appearance, and the focus ring on the board is
drawn on a non-interactive stand-in because a board cannot hold focus while it is
read. Only Chromium was checked. `pnpm check` was not run to completion for the
whole repository in this session.

## Migrating the callers

Every `Input`, `Textarea` and `Label` import in `packages/components` and
`site-docs` now points at `@lody/ui`, and `input.tsx`, `label.tsx` and
`textarea.tsx` are deleted with their barrel exports, which is the package rule
that a Radix file goes when its in-repo callers reach zero. `Label` becomes
`Field.Label`, imported as `UiField` wherever a surface already had a local
`Field` of its own; `site-docs` drops its ambient `@/ui/textarea` declaration.

Spending the contract on real call sites found two holes in it:

- `Textarea` accepted no `style`. The props were built by omitting `style` from
  `<textarea>` the way Base UI does, but Base UI re-adds it and this did not, so
  a surface that sets its own font size on the composer could not. `style` is
  back as `CSSProperties`; it carries layout a caller owns, not visual identity.
- `PasswordInput` typed its props from a raw `<input>`, so the HTML `size`
  attribute collided with the token step of the same name. A wrapper around a
  primitive follows the primitive's props, so it now extends `InputProps`.

`form.tsx` also kept typing `FormLabel` from `@radix-ui/react-label` while
rendering a Base UI label. The type follows the element it renders.

## Correction: the parts do require a root, and the ring follows aria-invalid

Two claims in the first version of this note were wrong, and both reached the
product.

**`Field.Label` does not work outside a `Field.Root`.** Base UI's Label,
Description and Error call `useFieldRootContext(false)`, whose `optional` flag
is false, so they throw without a root; only Control passes `optional` and
survives alone. This note had it backwards, and the caller migration was written
against the wrong reading: all 25 files that render `UiField.Label` do so with
no root, including the login page, every settings panel, onboarding and several
dialogs. Loading the `UI/Switch` story reproduced it — a blank surface and
`Base UI error #28` — so this was a crash on the way to shipping, not a
theoretical gap.

`Field.Label`, `Field.Description` and `Field.Error` now fall back to the plain
`<label>`, `<p>` and `<div>` when no root is above them, styled identically and
still honouring `render` through Base UI's `useRender`. A label with `htmlFor`
is meaningful on its own; the only thing lost outside a field is field state,
and outside a field there is none. Wrapping 25 surfaces in a root instead was
rejected: it changes the DOM and layout of files this change should not be
reshaping, to work around a primitive that should not crash.

**The invalid ring ignored `aria-invalid`.** Reading validity only from Base
UI's `state.valid` meant a caller that marks its own control — `agent-role-form`
does — put `aria-invalid` on the DOM and got no ring: a screen reader announced
invalid while nothing looked wrong. `Field.Root` renders its validity _as_
`aria-invalid`, so the attribute is not a second source of truth but the
rendered form of the one truth; `src/field/invalid.ts` reads it, and every ARIA
value except `false` counts, `grammar` and `spelling` included. StyleX has no
attribute selector, so the read happens in JS rather than in a condition.

Both were found by review rather than by the tests, which is the gap worth
naming: the package's tests render markup, so they can assert a class appears,
but nothing here mounts a real surface. The Storybook check that reproduced the
crash is manual.

## Follow-ups

`Button` still has no visible keyboard focus ring in the desktop shell; the two
open fixes are in the discovered-defect section above. Checkbox, Select and
Switch join the same `field` group rather than opening their own. Callers that
still pass Tailwind classes to a migrated control are carrying layout, not
visual identity, and are worth a pass once more of the family has moved.
