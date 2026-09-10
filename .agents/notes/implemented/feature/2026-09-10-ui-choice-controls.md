# UI choice controls: Checkbox, Radio and Switch

Status: implemented
Translation: pending

## Abstract

The `@lody/ui` field family covered the controls a person types into, while every
control a person picks with — 9 `Checkbox` call sites and 24 `Switch` ones —
still rendered Radix with Tailwind classes the new token rules define no
equivalent for, including a `primary` fill and a `switch-track` colour that are
not tokens at all. This note records adding `Checkbox`, `Radio` and `Switch` to
the same `field` token group rather than opening one of their own, and settling
the state the text controls never had to answer: a control that holds a value is
ink, the `label` fill under a `background` mark with the primary button's own top
highlight, because the rules reserve `accent` for live state. Each renders a real
`<button>` through Base UI's `nativeButton` rather than the default `<span>`, so
the family's existing `:disabled` and `:focus-visible` rules reach them and a
`<label>` can point at them; the cost is that the ring has to be restated for the
ink edge, since CSS cannot append to a box-shadow list. Every caller moved and
the three Radix files are deleted. The board was read in both palettes; no test
asserts a rendered appearance, and the switch's on state is ink rather than the
`accent` the rules mention for a "live switch", which is left for a surface that
actually has one.

## Problem

`packages/ui` owned the label, Input and Textarea. `packages/components/src/ui`
still owned `checkbox.tsx`, `switch.tsx` and `radio-group.tsx`, and their
Tailwind classes reach for a vocabulary the token rules do not have:

- `checkbox.tsx`: `border-input-border`, `data-[state=checked]:bg-primary`,
  `data-[state=checked]:text-primary-foreground`, `focus-visible:ring-ring/50`,
  `aria-invalid:ring-destructive/20`, `rounded-[4px]`, `disabled:opacity-50`
- `switch.tsx`: `data-[state=checked]:bg-primary`,
  `data-[state=unchecked]:bg-switch-track`, `focus-visible:ring-offset-2`,
  `disabled:opacity-50`, a 36×20 track with a 16px thumb
- `radio-group.tsx`: the checkbox's set again, plus `fill-primary`

Three problems compound there. The two disabled treatments are 50%, where the
rules say 45% and the field family already reads `field.disabledOpacity`. The
focus rings are `ring-offset` haloes, which the rules ban and which the desktop
shell suppresses anyway. And `primary` is the concept the new system deliberately
does not have: the rules replace it with an elevation rung plus ink, and a
migrated control that kept reaching for it would carry the old design forward
under a new import path.

`radio-group.tsx` had no caller at all and was not exported from the barrel, so
it was dead code carrying a `@radix-ui/react-radio-group` dependency.

## Decision

**They join the `field` group.** `field` now covers the label, the text
controls, the choice controls, the help text and the error. This is what the
field note said would happen, and the reason holds: five colour tokens declared
per component drift on the first redesign. `checkedFill`, `checkedMark`,
`checkedEdge`, `thumb` and `thumbShadow` are the only new colour-valued tokens,
and they join `fieldPaletteTheme` so they resolve inside a forced palette.

**Ink for a stored value, not accent.** The rules are explicit: "Ink for stored
state: primary button, checked, on. `label` fill, `background` text", and
"`accent` for live state only … Never a button fill." So a ticked box, a selected
radio and a switch that is on take `colors.label` with `colors.background` on top
of them. The elevation table already puts "switch off, checkbox off" on the well
rung; on is the rung the primary button sits at, so it takes `shadow.inkEdge` as
its top highlight too. The alternative — `accent` for the on state, which is what
most systems do and what the rules' own phrase "live switch" gestures at — was
rejected here because none of these 33 call sites is a live indicator. They store
a preference. A surface that genuinely shows something running can revisit it,
and the rules' sentence is the place to argue from.

**A real `<button>`, not Base UI's default `<span>`.** Base UI renders these
three as a `<span role="checkbox">` with a hidden input beside it, and its
`nativeButton` prop swaps in a `<button>`. The span is the wrong element for this
package for three separate reasons, each of which would otherwise cost a
mechanism:

- `:disabled` does not match a span. The field family dims a disabled control
  with `opacity` under `:disabled`, so a span would need the disabled opacity
  read from React state instead — a second disabled mechanism inside one family.
- A `<label>`'s labelled control must be a labelable element, and `<button>` is
  one while `<span>` is not. `Field.Root` renders `htmlFor` onto the control
  either way, but only the button turns a click on the label into a toggle.
- The repo's existing tests already query `button[role="switch"]`. Keeping the
  element keeps what those tests assert true rather than rewriting them around a
  new implementation.

The cost is that a disabled control drops out of the tab order rather than
staying focusable with `aria-disabled`. That matches how a disabled `<input>`
behaves in the same family, so it is the consistent answer rather than a new one.

**The ring is restated for each edge.** `well.box` composes the focus ring with
`field.well`; `well.checked` composes it with `field.checkedEdge`. This is the
same shape as Button, where each variant restates the ring with its own edge, and
for the same reason: a box-shadow list cannot be appended to from a second class.
Four states, two of them invalid, therefore cost four declarations in `well.ts`
rather than one. The alternative was drawing the ring on a `::after` pseudo
element, which composes with anything, but it would give this half of the family
a different ring mechanism from the text controls for no gain.

**Mixed is its own prop.** Radix modelled the third state as
`checked="indeterminate"`, so every call site typed the value as
`boolean | 'indeterminate'` and narrowed it back with `=== true` in its handler.
Base UI has a separate `indeterminate` prop, `checked` is a boolean, and the two
select-all call sites now pass `checked={allSelected}` beside
`indeterminate={someSelected}`. A mixed box wears the checked ink and draws a
dash, and announces `aria-checked="mixed"` — it must not fall back to the tick,
which would state a value the selection does not hold.

### Sizes

A checkbox and a radio are `field.boxSize` (16) at `radius.mini`, which is
exactly the "16px things" case the corner rule names; the radio overrides the
radius to a full round. The switch is a 28×16 track at `radius.full` with a 12px
thumb inset 2px, so its travel is derived in CSS from those three tokens rather
than written down as a fourth. 16 is also the checkbox's height, so a settings
list mixing the two lines up — which the old 36×20 switch did not, and which is
why `auto-review-menu-item` had reached for `scale-75` to shrink one.

There is no size ladder here. The 28 / 32 / 36 steps are heights for controls
that hold text; a tick box has no text to set.

### The mapping this closes

| Old Tailwind concept                       | New token                                 |
| ------------------------------------------ | ----------------------------------------- |
| `border-input-border`, `shadow-xs`         | `field.well` (`shadow.inset`); no border  |
| `data-[state=checked]:bg-primary`          | `field.checkedFill` (`label`)             |
| `data-[state=checked]:text-primary-fg`     | `field.checkedMark` (`background`)        |
| — (the checked box had no edge)            | `field.checkedEdge` (`shadow.inkEdge`)    |
| `data-[state=unchecked]:bg-switch-track`   | `field.background` (`wellBackground`)     |
| switch thumb `bg-background shadow-lg`     | `field.thumb` + `field.thumbShadow`       |
| `focus-visible:ring-ring/50 ring-offset-2` | `field.ring` (`accent`), 2px, no offset   |
| `aria-invalid:ring-destructive/20`         | `field.invalidRing` (`destructive`), 2px  |
| `disabled:opacity-50`                      | `field.disabledOpacity` (45%)             |
| `size-4 rounded-[4px]`                     | `field.boxSize` (16) at `radius.mini` (5) |
| switch `h-5 w-9` with a 16px thumb         | 28×16 track with a 12px thumb, inset 2px  |

The tick and the dash are drawn as inline SVG paths rather than taken from
`lucide-react`, because the package depends on React, Base UI and StyleX only.

## Migrating the callers

All 33 files import from `@lody/ui/checkbox` and `@lody/ui/switch`, and
`checkbox.tsx`, `switch.tsx` and `radio-group.tsx` are deleted with their barrel
exports and their three `@radix-ui` dependencies. `Radio` and `RadioGroup` ship
with no caller: the file they replace had none either, and a primitive library is
the one place where that is the right order.

Spending the contract on real call sites found three classes of caller state:

- **Visual overrides.** `workdir-mode-selector` rebuilt the checkbox at 12px in
  `muted-foreground/15` with its own checked colours and `disabled:opacity-100`,
  which is the reconstruction the package rule forbids and which stopped matching
  anything the moment `data-[state=checked]` became `data-checked`. It is gone;
  the pill holds the primitive.
- **Sizes that are now the primitive's.** `mobile-chat-list` and
  `mobile-project-screen` passed `h-4 w-4`, and `auto-review-menu-item` passed
  `scale-75`. All three were compensating for the old dimensions.
- **Layout and interaction.** `pointer-events-none`, `shrink-0`, `ml-4`, `mt-0.5`
  stay: they are the caller's constraint, not the primitive's identity.

`message-selection`'s tests read `[data-state="checked"]`, which is Radix's
attribute; Base UI writes `data-checked`. The four assertions moved with it.

## Correction: a squircle at `radius.full` is not a pill

The first version of this change gave the switch track and the radio
`radius.full` and left them under the squircle every control in `well.box`
carries, on the reading that the corner rule's "`corner.shape` on every radius"
covers the whole scale. It does not, and the result shipped visibly wrong: the
28×16 track rendered as a rounded rectangle rather than a stadium.

`corner-shape: squircle` does not degrade to a circle as the radius grows. It
draws a superellipse of that radius, so at `radius.full` a wide box becomes a
rounded rectangle and a square one becomes a squircle instead of a circle.
Measured in Chromium against `corner-shape: round` at the same radius, the two
are plainly different shapes at 28×16, at 16×16 and at 120×56.

`radius.full` therefore takes `corner.round`, a second constant beside
`corner.shape`, and the rule in `RULES.md` gains the exception. The switch track
and the radio box set it; the switch thumb and the radio dot never needed it,
because `corner-shape` does not inherit and their default is already round.
`Button`'s `pill` shape had the same defect since it was written and is fixed
with them: at `radius.full` a squircle is not the stadium the shape name
promises. The gallery's `radius.full` chip carried the squircle too, so the board
was showing a rounded rectangle under the label "pills"; it now renders the round
shape beside the four squircles.

Three tests pin it. They re-declare both corner shapes through `stylex.create`
and rely on StyleX hashing a class per property and value, so the expected class
is derived from the compiler rather than written down: the switch and the radio
must carry the round class and not the squircle one, the checkbox must carry the
squircle at its 5px radius, and the two classes must differ at all.

## Verification

`pnpm --filter @lody/ui test` (46 tests, 16 of them new) and
`pnpm --filter @lody/ui typecheck` pass, as does
`pnpm --filter @lody/components typecheck`. The new tests cover the rendered
element and role, the tick appearing only once the box holds a value, the mixed
box announcing mixed and drawing the dash rather than the tick, the checked state
swapping the well for the ink rather than stacking on it, the thumb differing
between tracks by its travel alone, the three sharing the box styles rather than
each defining one, an unchecked control wearing the same invalid ring class as a
text control while a checked one gets a different one composed with its ink edge,
`Field.Root` reaching the control with disabled and validity, the label pointing
at the control, and a caller class landing last.

The board was read in Chromium through Storybook at 1440px, values taken off the
rendered nodes in both palettes. The box is 16×16 at radius 5 with `corner-shape: squircle`,
the track 28×16 at `radius.full` with `corner-shape: round` and a 12×12 thumb
inset 2px that travels to 14px from the left.
Off is `rgb(232, 234, 237)` in Lody Light and `rgb(28, 28, 28)` in Vesper with
the matching inset; on is `rgb(26, 27, 30)` and `rgb(255, 255, 255)` with the ink
highlight; disabled reports opacity `0.45`. Focusing a control by keyboard
produced `… inset, rgb(93, 141, 239) 0px 0px 0px 2px`, an invalid one kept
`rgb(206, 34, 45)` while focused, and a checked one kept its ink edge under the
accent ring. Clicking the label toggled the box, which is the labelable-element
behaviour the native button buys. The console reported no errors.

The product shell was checked too, which is where the shell's Tailwind base layer
could have interfered: the `UI/Switch` story and the beta-features settings
section render at the right size and colours, and clicking a switch there flipped
the atom the surface reads.

Limits: no test asserts a rendered appearance, and the board itself draws no
focus ring, because a board cannot hold focus while it is read — the rings above
were read by focusing a control in the browser rather than from a sample.
`pnpm check` was not run to completion for the whole repository in this session;
`packages/components`' test suite fails on this machine before and after the
change with `act is not a function`, which was confirmed by running the same
file against the base commit and is unrelated. `THIRD_PARTY_NOTICES.md` still
lists the three removed packages: regenerating it here would rewrite the whole
file against a different dependency snapshot, and the field migration left it in
the same state. Only Chromium was checked, and no mobile surface was opened.

## Follow-ups

`Button` still has no visible keyboard focus ring in the desktop shell; the two
open fixes are in the [field primitives note](2026-09-09-ui-field-primitives.md).
Select and Combobox are the next slice and are the first controls in this family
to need popup, keyboard navigation and overlay tokens. Whether a switch that
reports something live should take `accent` rather than ink is open, and belongs
to the first surface that has one. `THIRD_PARTY_NOTICES.md` and the generated
attributions want one regeneration pass together.
