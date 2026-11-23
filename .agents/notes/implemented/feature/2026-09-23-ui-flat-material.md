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
- **The switch.** On was briefly a layer growing from the start edge with the
  thumb. The owner asked for it back: the whole track now turns to the accent
  fill again, cross-faded while the thumb slides, the way platform switches
  read. The emoji slot gained a 6px gap before the value.

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

## Second correction: one recessed material, lit correctly

The owner rejected the flat fields as well. Sunken was never the problem in
itself: when cards lift and buttons stand up, a flat field is the one thing
without material, and that breaks the language the way the sunken/raised mix
did. Every value holder, Selects included, is recessed again, still as one
material.

What made the first recess look like a hole was how it was lit, and there were
two causes. In Lody Light the fill was a 92% gray on a white card. In Vesper the
well (11%) was lighter than the card (8.6%) under a heavy black inner shadow,
which is contradictory light. The recess is now shallow and lit from above:

- a short inner shadow at the top edge, an inner hairline, and a lit lower lip
- a fill just under the surface: 95% in light, and 4.5% in Vesper, darker than
  the page, so it still reads on the darkest ground (6.5% vanished there)

`Combobox.Button` and the in-popup search stay; they read the well like every
other field.

The owner then found the Vesper recess too contrasty: a fixed 4.5% tuned against
the darkest page made deep black slots on a 10% card. The fill is now a
translucent darkening of whatever it sits on — ink at 5% in light (unchanged to
the eye on white), black at 28% in Vesper, with a lighter top shadow — so a field
is the same small step under every rung. The owner picked this (B) from three
Vesper variants: A (the fixed 4.5%), B (28%) and C (16%).

## Business layer: StyleX, not a Tailwind bridge

Syncing the new material into the business layer first went through a Tailwind
"material bridge": utilities and `--shadow-*` values restating `@lody/ui`'s
numbers. The owner stopped that. Styling that can move to StyleX moves to StyleX,
reading `@lody/ui`'s own tokens, so there is one source of truth instead of two
copies kept in step by hand.

- `@lody/components` depends on `@stylexjs/stylex` (0.19.0, the version
  `@lody/ui` pins). The unplugin already runs over every module in the Electron,
  Storybook and Vitest builds, and `@lody/ui` already exports
  `tokens/colors.stylex` and `tokens/scales.stylex`. The app's `ThemeRoot`
  classes already carry the chosen palette to those tokens.
- Structure mirrors `@lody/ui`. Styles live in the component's `stylex.create`,
  and an area's shared look lives in its `surface.ts` (`settings/surface.ts`
  first). `lib/stylex.ts`'s `withClassName` appends a caller's layout class.
  Copy that follows the font-size tier keeps `em`. A StyleX or Tailwind visual
  class is never passed into an `@lody/ui` part: two classes setting one property
  are ordered by the stylesheet, not by the class list.
- `CompactSection` / `CompactRow` / the form primitives are StyleX. A section
  owns the rules between its lines (StyleX has no descendant selector, so it
  wraps each child). The danger zone is `tone="danger"` rather than a caller's
  ring class. Header actions are `@lody/ui` ghost icon buttons rather than
  Radix-era props with a `shadow-xs` override.
- The rest of the sweep is split by area: settings catalogs and editors,
  account/workspace/general settings, composer selectors (`OptionSelector` and
  the run-config menus), and the most visibly split surfaces elsewhere.
- Owner corrections after the sweep. The panel's padding had wrapped
  `AgentConfigDialog`'s type picker, so the picker no longer met the dialog's
  edge. The panel now takes `padding: 0` through `style` (the settings modal
  does the same): the picker is a flush sidebar with one separator line, and
  the form pads itself. Settings editor forms have no padding of their own,
  because the panel pads them, so their story frames pad like the panel does.
  A popup row's highlight has no transition. It follows the pointer and the
  arrow keys, and a fade left it lagging behind them.

## Tabs are a tray, not a well; billing joins the settings cards

The owner found the tab strip dated, "from a different century" next to
everything else. The strip had borrowed the fields' recess. In Lody Light that
drew a rimmed box with a second, outlined box inside it, like an old button
group. In Vesper it drew a black slot holding a flat gray block. A tab picks what
is shown, not what is stored, so the strip leaves the well:

- The track is a flat tray with no rim and no inner shadow: new palette tokens
  `trayBackground` (ink 6% / light 6%) and `trayRaised` (white / 21%). In Vesper
  the key has its own value because the raised rung (13.7%) sits level with a
  light tray.
- The inset is 2px rather than 4px, so the pill nearly fills the tray: a 32px
  strip holds a 28px pill at `radius.small`.
- Value holders keep the well. The two hand-built two-way strips (the
  share-image dialog, the queued-message setting) read the tray tokens too.

Billing (`billing-setting-pure.tsx`) was still Tailwind. Its cards used the
padded `Card` and then padded their contents again, and the offer and history
cards drew a tinted header band with a rule under it. So the heading, the body
and the neighbouring cards each started at a different inset. It is now
`CompactSection`s in StyleX: one 16px inset on every line, group names above
their cards, invoices as ruled rows, the redeem and payment rows as
`CompactRow`s, and the interval switch a `Tabs` strip whose panel is the price.
The workspace-creation page still has its own hand-built interval switch.

## The conversation reads on three steps

The owner found the turn visually confused, the weight in the wrong places.
The process rows competed with the reply: group summaries ("Finished working",
"Read 1 file") were body-sized, steps were medium-weight gray, some titles
brightened their first word, file names switched to mono, and icons were as
loud as their text. Now the reply is the text; a group summary is 0.9 of it,
secondary, set close (1.5 leading, 2px between summaries); a step is 12.5px at regular weight with
its icon a tone lighter; a step's file name stays in the sentence's type. The
brightened first word stays, as the owner asked, but as a verb with tense: in
progress while the tool runs ("Searching", shimmering), done once it has
("Searched").


## Rings on top, and the provider dialog's structure

- A focus ring now comes first in every composed box-shadow. It came after the
  edge, and earlier shadows paint on top: a field's lit lower lip (a 1px light
  line under it) covered the ring's bottom edge, so the ring read 2px at the
  sides and 1px below. Buttons' hairline and contact shadow did the same.
- `AgentConfigDialog`: the wide layout drops the rail's "Choose a type" title —
  a second heading beside the form's — and puts the search on the form header's
  row. Testing a runtime path or a custom command is a square button beside the
  field: its glyph cross-fades between play, spinner, tick and warning, and its
  tooltip (opening left) says the action at rest and "Ready" once it passed.
- The optional settings (title generation, custom prompt, environment) were
  three 12px gray captions that could not hold the lower half of the form. They
  are one block now: a region card of ruled 40px rows, each naming its setting
  at the control step with its count and actions at the end and the chevron
  last, folding open in place.

## Project settings: every source at once

The owner rejected Settings > Projects outright. Its two-pane catalog hid all
but one source behind a picked row, left a mostly empty right pane, and read
"1 projects". It is now one page in the settings language: each machine (then
each GitHub owner) is a `CompactSection` — its name and state ("MacBook Pro ·
Offline · Shared") above, its "Add folder" or "Manage in GitHub settings" at
the end — and its projects are the ruled rows of that card: name, path in mono,
what is true of it, a chevron, and the delete menu. A project still opens its
editor in the nested modal. `settings/AGENTS.md` records the new layout.
Also: conversation steps are as wide as their words and brighten their file
name on hover; the MCP transport is a segmented strip rather than two radio
rows (radios stay where each option carries a sentence).

## A project is a window

The owner found the stacked Projects page thought-through only at the list:
what opens under a project was one long scroll — header, share, two 8-row
script editors, skills, conversation sync, delete — and the sync list, which
can hold thousands of conversations, rendered every one inside a card with no
search and only "select all". The editor is now a 960×680 project window: a
rail with the project's identity (name, machine and state) and its pages —
General, Worktree, Skills, Conversations (showing the conflict count, or how
many wait to import) — beside the page. General holds the folder (copy /
reveal), the machine, sharing and the danger zone. Conversations is built for
scale: the agent strip with "last synced" and Sync beside it; search and a
state filter (All · To import · Imported · Conflicts, with counts); "Select all
N shown" acting on what the filter shows; "Import N"; and a windowed list
(`virtua`), so five thousand rows scroll like five. Mobile keeps its own
sheets and the shared import panel.
A conversation step's file name is now a link: the row is `select-none`, and
only the name brightens and underlines under the pointer.

## A background task is a peek

Clicking a background or subagent task opened a full dialog that repeated the
row — name, "Running", and the same sentence in a mono box. The owner asked
for a zero-based answer, not a collapse. A task has no live output, so there
is nothing a page is for: the row now says what the task is and the word its
state needs (elapsed time ticking while it runs, the tool it is on, how long
it took, or Failed), and clicking it opens a popover anchored to the row with
the task at full depth — status and time, the whole command or brief with
Copy, the result or error, what it cost, and Cancel for a subagent. The group
lost its bordered card and reads as a step of the turn's process like the
rest.

## Owner review: a livelier project rail, clearer light cards, clickable steps

- The project window's rail was plain. It now carries the project's face (the
  GitHub owner's avatar, or the name's initial on a tint derived from the name),
  a status dot beside the machine, a glyph per page (the current one in accent),
  a selection fill that slides between pages, and count pills (amber for
  conflicts).
- Lody Light cards were hard to tell from the page: `shadow.card`'s hairline
  goes from 7% to 12% ink and its contact shadow from 4% to 6%.
- A file step with nothing to unfold (a read) opens its file when the row is
  pressed, and the file name brightens with the row's hover; a step that
  unfolds keeps the row for that and its file name is the link.

The owner found that rail cheap — a tinted initial tile, coloured page glyphs
and pills are the stock vocabulary. It is typographic now, and it does a job
only it can: each page states its page's condition ("Shared with team", "No
scripts", "2 to import · 1 in conflict" in amber), so the rail is the project
at a glance. The identity is the name over its path with the last segment lit,
then the machine; the current page is a 2px accent hairline that slides.

Still not right, and the reason was the sidebar itself: four views of one
project do not need a navigation column, and every version of it was a tall
empty column with a few entries. The window is now a header — the name, the
path with its last segment lit, the machine with its status dot — over text
page tabs whose underline travels to the current one, and the page at full
width. The page tabs are deliberately not tray strips: the pages use trays for
their own choices (agent, state), and a strip over a strip read as one level.

Related: [token gallery](2026-09-09-ui-token-gallery.md),
[call-site migration](2026-09-22-ui-radix-callsite-migration.md).
