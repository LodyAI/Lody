# UI flat material: one light above, crisp edges, no grime

Status: implemented
Translation: current

[中文版](2026-09-23-ui-flat-material.zh.md)

## Abstract

The owner asked for Lody's V2 interface to feel slightly physical — flat, lightly
skeuomorphic — without looking dirty. On the token board, the dirt came from two
things. In Lody Light every raised part was a mid-gray (`hsl(216 17% 94.3%)`) on
gray or white: a tab's pill sat 6/255 above its track, and the switch thumb was
gray on the accent. Every shadow was also a single soft blur, which spreads into
a gray haze. The fix is the logic of one overhead light rather than any picture
of a material. Raised parts are white and read by a 0.5px hairline, a contact
shadow and a short, negatively spread lift. Wells stay recessed. A new `sheen`
token group lays a light fall-off of a few percent over raised faces, and a press
removes it. No grain, noise, gloss or grooves were added, which follows the
brand research's standing rejection of realistic material.

## Problem

The elevation ladder was right in structure and wrong in light. A raised part
that is darker than the card it rests on reads as a stain rather than an object,
and a gray raised part under a 1px 2px blur has no edge at all: the secondary
button, the tab indicator, the switch thumb and the whole floating rung had this.
The popover shadow `0 18px 50px / 0.14` drew a gray cloud around every menu.

## Evidence from the brand research

`LodyAI/lody-ui-v2-brand-research` was consulted as a secondary input. Its
relevant findings:

- Rounds 11, 20 and 21 rejected realistic light, reflections, recessed grooves,
  grain and photographic textures ("I don't need such realistic materials").
  Physicality here therefore has to come from luminance, edge and offset.
- The product CSS it quotes already prefers "true-white elevated cards" over a
  cool off-white canvas, and warns that warm cream grounds make white dropdowns
  look pasted on. The palette hue (216–225) is kept for that reason.
- Paper tones, powder/lime accents and offset outline sheets are brand-layer only
  and were not brought into tokens.

## Decision

- `raisedBackground` in Lody Light is white. Vesper is unchanged.
- Every lifted shadow is a hairline, a contact shadow and a lift with negative
  spread. Vesper draws the hairline in light at 6–10% and keeps the inset top
  highlight. Values live in `colors.stylex.ts`. `RULES.md#material` is the rule.
- `shadow.inkEdge` gains a contact shadow, so ink and tone fills — primary,
  destructive, checked box — sit on the surface instead of being printed on it.
  The destructive button now reads this token instead of a literal.
- New `sheen.raised` / `sheen.ink` tokens, used through component tokens
  (`button.primarySheen`, `button.secondarySheen`, `field.checkedSheen`,
  `field.thumbSheen`, `disclosure.indicatorSheen`) and re-declared by `ThemeRoot`.
- Pressing drops the sheen with the lift. A secondary button keeps its hairline
  and gains a one-hair inset (`button.pressedEdge`), because on the white card
  rung it would otherwise vanish under the finger.

## Alternatives not taken

- **Noise or grain overlay.** It is the quickest route to "physical", and it is
  exactly what the owner's research rejected. At small UI sizes it also reads as
  dirt, which is the problem being fixed.
- **Off-white page ground with white cards.** This would give cards lift in the
  light palette. But it moves the page token that product surfaces and several
  rules (the neutral alert's tint, card nesting) depend on. It is a separate
  decision.
- **A lighter Vesper raised rung.** The dark tab pill (35 on 28) is still quiet.
  The top highlight and hairline carry it for now. Raising the rung changes
  `selectedFill` parity and would need its own board pass.

## Verification

- The Storybook token board (`Design System/UI Gallery`, Lody Light and Vesper)
  was captured in Chromium before and after. Buttons, tabs, switch, menus,
  dialog and card were read by eye in both palettes.
- `@lody/ui`: 276 tests pass (`NODE_ENV=development vitest run`), and
  `tsc --noEmit` is clean. The gallery test now also requires every `sheen`
  token on the board.
- Limit: product surfaces still on Tailwind tokens do not change. The board and
  migrated `@lody/ui` callers are the only verified surfaces. No human visual
  sign-off yet.
- The Storybook preview imported the deleted Radix `src/ui/tooltip`, and every
  story failed to load. It now uses `@lody/ui/tooltip`'s `Tooltip.Provider`.

## Business layer: the settings prototype

The owner asked whether this would make the whole product feel heavy, since a
visual system is carried by business components as much as by atoms. Measured
before and after in real surfaces, it would not. The atoms changed almost
nothing a person would see: a secondary button turns white with a hairline, and
menus and dialogs lose their haze. The weight was in the business layer's own
containers, which contradict "depth without lines":

- 161 files in `packages/components` draw Tailwind `border`s, with 129 uses of
  `rounded-lg border`. The settings sections wrap a header band with a rule
  under it, and the Agent Role form nests bordered boxes inside a bordered card.
- The business layer paints over atoms. `account-setting-pure.tsx` and
  `change-password-button.tsx` gave a ghost `Button` a gray fill through
  `className`, which the `@lody/ui` rules forbid.
- A standalone settings story renders outside `data-settings-surface`. It
  therefore shows gray cards the app never draws, and settings must be judged
  inside that scope. `Design System/Settings Material Study` does that with four
  real surfaces.

The prototype changes the shared settings containers rather than individual
pages, so every page using them moves together (16 files use `CompactSection`,
5 use `SETTINGS_ROW_CARD_CLASS`):

- `CompactSection` and `SETTINGS_ROW_CARD_CLASS` are borderless 14px cards whose
  edge is `shadow.card`, restated in Tailwind because this layer does not
  compile StyleX. The two must be kept in step until a `@lody/ui` grouped-list
  primitive replaces them. A section's title sits above its card, rows split by
  a line, and the danger zone marks itself with a destructive hairline ring.
- The `form-primitives` `Section` draws no box. A form is one surface, and its
  groups are set apart by space. The Role form's two note rows take the region
  fill instead of a border.
- Material budget: a standalone action in a row is a real `secondary` button,
  never a ghost painted gray.

Still bordered and not yet migrated: the machines overview table, the Role form
dialog frame and its footer rule, and every non-settings surface. The 14
settings test files (90 tests) pass and the components typecheck is clean.
Verification was visual, in both palettes, on the study story; no human
sign-off yet.

## Presentation: what belongs with a value is inside its well

The owner's next point was that some of what felt wrong was the form of
presentation rather than the material. The Agent Role and Prompt Shortcut
editors put an emoji picker and a name field side by side, as two controls with
two edges and two focus rings. The emoji and the name are one label, though, so
they should be one control. The shortcut's `/command` field showed the same
thing from the other side: a hand-built Tailwind box (its own border, fill and
ring) held a `/` beside a bare `Input`.

`Input` gains a `leading` slot, built from the input's own `render` the way
`PasswordInput` builds its shell. The input stays the field's one control, so
a `Field.Label` still points at it and validity rings the shell. The slot is a
square the well's height less a 4px inset, so a pressable emoji fills it and a
`/` is centred where the value's padding would be. `EmojiField` became that
pressable part: it has no edge, and it hovers with a fill mixed toward the ink.
Both editors now use the slot, and the hand-built slash box is gone.
`test/field.test.tsx` pins the label association, the ring on the shell, and
where `className` and `inputClassName` land.

## Owner review in the running app: one line per row, one kind of control

The owner's screenshots of the running app showed four more defects:

- **Rows broke in two.** The run-config menu drew each icon above its label and
  the tick below its model. Rows migrated with their Radix markup pass a mark, a
  value or a switch as children. `@lody/ui` put all of that in the label slot,
  and preflight's `svg { display: block }` gave each glyph a line of its own.
  The label slot is now a line, with words boxed so they still truncate
  (`popup/row-label.tsx`). That fixes every such caller at once: 27 files go
  through the product `Menu` wrapper alone. The run-config rows also moved onto
  `icon` and `endContent`.
- **Mixed sizes.** A form trigger at 36px with 12px text (`h-9 text-xs`) opened
  a list of 28px rows at 13px. Both editors dropped the overrides, so the medium
  control sits over rows that are its height less the popup inset.
- **Four kinds of select on the Appearance page.** The hand-built
  `PreviewSelect` became a `@lody/ui` Select that previews the focused row and
  cancels when closed without a pick. Both font pickers became Comboboxes, and
  the terminal size became a `NumberField`.
- **The switch.** On is now a layer that grows from the start edge with the
  thumb, not a whole-track colour swap. The emoji slot gained a 6px gap before
  the value.

## Correction: one flat material for every value, nothing sunken

Two turns of this PR each broke a column in two, and the owner rejected both.
Sunken fields on a raised card read as holes cut into it. Raising only the
Select trigger ("typed into is sunken, pressed is raised") then made a form one
half holes and one half blocks, which was worse.

Research into other systems showed the split is real. Native-modelled systems
(macOS, WinUI 3, Radix Themes classic) raise a select like a button;
form-modelled ones (Primer, Material, Fluent web, Bootstrap, shadcn) give it
the input's material. In Radix classic the two still read as one family only
because both fields are near-white and differ in light direction alone. Here
the difference was a 92% gray fill against white.

The rule is now that everything holding a value is one flat material. Inputs,
textareas, Select and Combobox triggers, numbers, passwords, and the tracks of
checkboxes, radios, switches and tab strips all use a fill a step off the
surface (`wellBackground`, lightened to 96% / 12%) with one inner hairline
(`shadow.inset`, no longer an inner shadow). Only pressable things (Buttons,
thumbs, tab pills) stand up. The raised-trigger tokens were removed.

For the font pickers the owner chose a Select-like trigger over a typed field.
`Combobox.Button` uses the Select trigger's styles (now shared in
`field/trigger.ts`), and `Combobox.Content search` puts `Combobox.Search` at the
top of the popup. That makes the Appearance column one kind of control, and it
is the part `OptionSelector`'s callers can move onto.

Related: [token gallery](2026-09-09-ui-token-gallery.md),
[call-site migration](2026-09-22-ui-radix-callsite-migration.md).
