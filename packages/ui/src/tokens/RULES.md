# Token usage rules

Construction: depth without lines. No border token exists. Surfaces separate by
luminance step and shadow; controls are wells (sunken) or raised. The material is
flat with one light above it: see [Material](#material).

## Elevation ladder

One rung per component. The rung fixes background and shadow together.

| rung     | background            | shadow                     | examples                                                                          |
| -------- | --------------------- | -------------------------- | --------------------------------------------------------------------------------- |
| well     | `wellBackground`      | `shadow.inset`             | input, select, textarea, switch off, checkbox off, segmented track, selected item |
| page     | `background`          | none                       | app ground                                                                        |
| region   | `secondaryBackground` | none                       | sidebar, footer band, a block inside a card                                       |
| card     | `elevatedBackground`  | `shadow.card`              | card, panel, composer, alert                                                      |
| floating | `raisedBackground`    | `shadow.popover`           | menu, popover, select list, toast, tooltip                                        |
| modal    | `elevatedBackground`  | `shadow.large` + `overlay` | dialog, alert dialog, drawer                                                      |

## Edges

- `separator`: next row. Dividers between list and table rows only. Never
  around a surface, never under a header.
- well: you can put something here. `wellBackground` + `shadow.inset`.
- raised: you can press this. `raisedBackground` + `shadow.raised` +
  `sheen.raised`. Primary and destructive buttons are raised with
  `shadow.inkEdge` and `sheen.ink`: a top highlight and a contact shadow.
- shadow: above the page. Strength by rung, and always a hairline and a contact
  shadow, plus a lift for anything that floats — never one soft cloud. A card
  rests on the page and takes no lift: a wide blur under every block of a page
  draws a halo that reads as a second layer behind each one.
- ring: attention here. A 2px `box-shadow` composed with the control's own
  shadow, tight to it, no offset, no glow. `accent` on focus, `destructive` on
  invalid. Not an `outline`: the product shell resets outlines with `!important`.
  A focus ring marks where keyboard navigation is, so its width is
  `focus.ringWidth`, which `installFocusModality` zeroes while the person uses a
  pointer — `:focus-visible` alone also lights the control a dialog hands focus
  back to after Escape. A text field keeps its own 2px: whoever types there needs
  to see where.

## Color

- `label` is the thing, `secondaryLabel` is about the thing, `tertiaryLabel`
  is a hint: placeholder, help text, chevron, icon at rest.
- Ink for the primary button: `label` fill, `background` text.
- `accent` for the states the eye should find: focus ring, link, stored
  state (checked, on), live switch, running indicator. Never a button fill.
- `success` and `warning` report an outcome rather than an action, so they mark
  and tint a message and never fill a control a person presses. `destructive`
  is the third: an action that destroys, and an outcome that failed.
- Disabled is 45% opacity on the whole control, not a color.
- Semantic first, gray second. `gray…gray6` only for things with no role:
  scrollbar, tracks, kbd, skeleton, an avatar's stand-in.

## Fields

**Everything that holds a value is one recessed material.** Input, textarea,
Select and Combobox triggers, a number, a password, and the tracks a checkbox,
radio or switch sits in all take the well: `wellBackground` under
`shadow.inset`. In a system where cards lift and buttons stand up, the fields
are material too, and they are all the same material — a column that mixes a
recess with a raised or a flat field reads as two kinds of thing. The recess is
shallow and lit from the same light as everything raised: a short shadow inside
the top edge, one inner hairline, the light catching the lower lip. Its fill is
a translucent darkening of whatever it sits on (`wellBackground` is ink or black
at a few percent), so a field is the same small step under a card, a dialog or
the page — never a fixed mid-gray, which read as a hole on white and as a deep
black slot on a Vesper card.

Never a border. One component token group, `field`, serves the whole family — input,
textarea, checkbox, radio, switch and the Select and Combobox triggers — so a
state has one colour in one place instead of one per component. The lists those
triggers open are on the floating rung and read `popup` instead; see below.

| state       | what it is                                                                        |
| ----------- | --------------------------------------------------------------------------------- |
| rest        | `field.background` and `field.well`; the value in `field.value`                   |
| placeholder | `field.placeholder`, the hint colour; it is a prompt, not a label                 |
| focus       | 2px `field.ring` (accent), tight to the control, no offset                        |
| invalid     | 2px `field.invalidRing` (destructive), at rest and while focused                  |
| disabled    | 45% opacity on the control; the label and help dim with it                        |
| checked, on | accent: `field.checkedFill` under `field.checkedMark`, `field.checkedEdge` on top |
| mixed       | the checked appearance with the dash, and it announces `mixed`                    |
| selected    | the tick, and a quiet fill on the row that is current, not on the control         |

**What belongs with a value is inside its well.** An emoji before a name or the
`/` before a command goes in `Input`'s `leading` slot, not beside the control:
two controls side by side are two edges and two rings for one fact. The slot is a
square the well's height less a 4px inset, at the well's radius less that inset.
A pressable glyph fills it and draws no edge, because the well rings on
`:focus-within`; a character is centred in it in `field.icon`.

A checkbox and a radio are the "16px things" the corner rule names: a
`field.boxSize` box at `radius.mini`, round for a radio. A switch is a
`field.switchWidth` by `field.switchHeight` track at `radius.full` holding a
`field.thumb` thumb raised with `field.thumbShadow`, the same height as the box
so a settings row carrying both lines up. Off is the well. On, the whole track
turns to the accent fill, cross-faded at `duration.fast` while the thumb slides
— the way every platform's switch reads. A layer growing from the start edge
was tried and dropped: its leading edge was a hard vertical line crossing a
pill. On is also where the well's shadow gives way to `field.checkedEdge`. Because CSS cannot
append to a box-shadow list, a control that changes its edge restates the ring
with it, the way each Button variant does.

These three render a real `<button>` with Base UI's hidden input beside it, so
`:disabled` and `:focus-visible` reach them the way they reach an `<input>` and
a `<label>` can point at them.

The control's own text follows the control rule at every size on the ladder: 13
at weight 500 with `text.controlTracking`. Label at 12 weight 500 in
`field.label`, help at 12 weight 400 in `field.hint`, error at 12 weight 400 in
`field.error`, stacked at `field.gap`. Disabled reads `field.disabledOpacity`
rather than a literal, so the control and its label cannot drift apart.

`Field.Root` owns the name, the disabled flag and validity. A control reads that
state and picks its own classes from it; it does not take a second `invalid` or
`disabled` prop for the caller to keep in sync.

The invalid ring follows `aria-invalid`, which `Field.Root` renders onto its
control, so the attribute is the state rather than a copy of it. What a screen
reader announces and what a sighted person sees cannot disagree, and a surface
that owns its own validation marks one control without a field around it. Every
ARIA value except `false` is invalid, `grammar` and `spelling` included.

### Popups and lists

A control on the well rung opens a list on the floating rung, and the two do not
share a token group. `field` covers the trigger — the size ladder, the ring, the
invalid ring, the disabled opacity — and `popup` covers the list, because that
list has more in common with a menu than with an input. A menu reaching for
`field.background` would be naming the wrong thing to get the right colour.

A popup is `popup.background` with `popup.shadow` at `popup.radius`, inset by
`popup.inset`, so its rows take `popup.itemRadius` — outer minus inset, 14 less
4, rather than a token of their own. A row is a `popup.itemHeight` control that
happens to live in a list, so it follows the control type rule.

A row states two facts at once. `highlighted` is where the keyboard or the
pointer is right now; `selected` is the row that holds the value, and carries
the tick. The highlight wins the fill, because it is the one that moves; the
tick keeps saying which row is current when it lands there.

Both fills are derived from the rung rather than taken from `hoverFill` and
`selectedFill`, which this table names for a row but which were tuned against
the page and card rungs. Measured on the floating rung, `selectedFill` resolves
to exactly `raisedBackground` in the dark palette, so that state is invisible
there — and while the light floating rung was gray, `hoverFill` landed 2/255
from it too. A derivation keeps working whatever the rung's value is. Mixing `raisedBackground` toward `label` steps away
from the surface in both directions at once, which is the derivation `Button`
already uses for a secondary button's hover.

A popup opens anchored 4px under its control and rises into place, rather than
overlapping it to line the current row up with the value. That is the motion
rule applied: a popup rises from 4px below at `duration.regular`.

A row has no edge of its own, and says so. A popup moves keyboard focus onto the
highlighted row, and a host that rings any focused element would draw a border
around it; the fill is how this system marks where the keyboard is, so the row
declares `box-shadow: none` rather than leaving the property unclaimed. The
"nothing matches" line collapses to nothing while it holds nothing, because it
stays mounted for a screen reader to announce into and would otherwise open
every popup with a blank row.

### Menus

A menu is that same surface with commands on it, so it reads `popup` too and its
rows are the rows above: one height, one radius, one highlight. Exactly one
declaration differs. A list takes `--anchor-width`, because the control it
belongs to shows the value it holds and the two read as one control; a menu is
opened by whatever the surface already had there — often a 28px icon button — so
it takes `popup.menuWidth` and grows past it for its longest row. A menu scrolls
in its own box rather than between scroll arrows, because its rows are the
popup's own children.

| part            | what it is                                                                  |
| --------------- | --------------------------------------------------------------------------- |
| leading box     | `popup.indicatorSize`, at `popup.hint`: a caller's icon, a tick, or a dot   |
| label           | the row's text; it takes the width, so a long one truncates                 |
| shortcut        | trailing metadata at `caption`, in `popup.hint`, never growing or shrinking |
| submenu chevron | drawn by the part, so a caller cannot forget it                             |
| destructive     | `popup.destructive` label, `popup.destructiveHighlight` under the keyboard  |
| open            | the row owning an open submenu keeps the highlight fill                     |

A row's label slot is a line, not a block: whatever a caller puts in it — a
value beside the name, a mark, a switch — stays on the row's one line, and its
words are boxed so they can take the ellipsis. The leading box, `shortcut` and
`endContent` are still where an icon, a key and a trailing control belong. The
line is what keeps a row migrated with its old markup from breaking in two.

A row that holds no icon holds no box, so an icon-less menu is not indented for
nothing; a row in a mixed list asks for the box with `inset` and lines up with
its neighbours. A checkbox or radio row's leading box is its state and nothing
else: the mark is unmounted while the row is unticked, so a caller's glyph
sharing that box would slide sideways every time the row was toggled.

Destructive is a tone of the row rather than a component: one class changes the
label colour and one changes the fill under the keyboard, and everything else
about the row is what every other command takes. The fill is mixed toward
`destructive` for the reason `highlight` is mixed toward `label` — on this rung
the named fills collapse into the surface.

The rise applies to a menu too, but a menu flips to stay on screen and a submenu
opens beside its row, so the 4px is measured against the anchor rather than the
page: the popup starts one step further from what opened it, on whichever side
it landed, and closes that step as it arrives. A context menu is anchored to the
pointer instead of to a control, so it takes no gap at all.

### Popovers

A popover is that surface with content on it instead of rows, so it reads `popup`
as well. It replaces five of a list's declarations and no more: the
`--anchor-width` a list takes because its control shows the value it holds, the
`popup.inset` that lets a row bleed to the surface's edge — prose needs room, so
it takes `popup.panelPadding` and stacks at `popup.panelGap` — and the three that
make the type a control's. What is in a popover is sentences, so it follows the
prose rule, 14 at weight 400; a control placed inside one brings its own step.
Its heading is the control step at weight 600 rather than a dialog's `headline`,
because a popover does not own the window, and the sentence under it is
`popup.description` at 12.

## Modals

The modal rung is the one rung that states three things at once:
`dialog.background` under `dialog.shadow`, over `dialog.overlay`. A panel here
covers what a person was doing and still shows it, so the page has to recede
rather than merely sit behind something.

One group, `dialog`, serves the whole family — the Dialog, the AlertDialog and
the Drawer — for the reason `field` serves the whole control family: the three
differ in how they arrive and in what may dismiss them, not in what they are made
of. A padding or a heading has one place to change rather than three.

| part        | what it is                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| panel       | `dialog.width` wide, `dialog.padding` in, at `radius.large`, `dialog.inset` clear of the window on every side |
| header      | the title and one sentence about it, at `dialog.headerGap`: one block                                         |
| title       | `headline`, weight 600, in `dialog.title`; `title` stays for a full page                                      |
| description | prose at `dialog.descriptionSize` in `dialog.description`                                                     |
| footer      | the answers, from the end, at `dialog.footerGap`; stacked in reverse when narrow                              |
| cross       | a ghost icon button in the corner, on a panel a person may dismiss                                            |
| drawer      | the same panel arriving from an edge, `dialog.drawerSize` across                                              |

The safe-area insets are read with `env()` rather than through a host variable,
so the package stays platform-neutral: on a desktop browser every one resolves to
0 and the panel is centred, and on a device with a notch and a home indicator it
sits between them.

The rise applies to a panel too, but a dialog is centred rather than anchored, so
the 4px is composed into the centring transform — CSS has one `transform`, and a
second class setting only `translateY` would replace the centring rather than add
to it.

### Drawers

A drawer is that panel arriving from an edge, and it is not a dialog pinned to
one. A panel that slides in from an edge promises that it can be sent back, and
on a touch screen a person will try; a dialog cannot answer that gesture, so the
system has no "sheet". The panel is laid out by a viewport rather than positioned
by itself, which is exactly what leaves its `transform` free to carry the drag —
a centred dialog has already spent that property.

Two axes. **Which edge**: `top`, `bottom`, `start` and `end`, stated in writing
direction, with the physical swipe derived from it so a drawer on the start edge
is swiped away leftwards in a left-to-right document and rightwards in a
right-to-left one. **Flush or inset**: flush meets the window, squares the two
corners that touch it, and pads its own content clear of the safe area; inset
floats at `dialog.drawerInset`, keeps all four corners, and takes the safe area
as viewport padding instead. A flush drawer is part of the window; an inset one
is an object resting over the page.

A drawer crosses the window rather than rising 4px, so it takes `duration.slow`.
The backdrop lifts with the gesture rather than only at the end: the page comes
back as the drawer leaves, so a half-dismissed drawer reads as reversible.

## Tooltips

A tooltip is on the floating rung: `tooltip.background` is `raisedBackground`
and `tooltip.label` is `label`, under `shadow.popover` — the popup surface's
material, so it is light in a light palette and dark in a dark one. It never
inverts: a dark chip over a light surface reads as a foreign patch rather than
as a name for what is under it. It keeps a token group of its own because its
geometry is a chip's, not a popup's — `radius.small`, tighter padding, the
footnote step and a maximum width — and a popup is a place to act while a
tooltip only names one. Under a forced palette the colour tokens travel with
the portalled chip like every other floating part's.

It is a hint about something else, so it takes the footnote step the rules give
help text rather than the control step its trigger takes, and it wraps at
`tooltip.maxWidth` rather than trailing off into an ellipsis a person cannot
open. It never takes the pointer: one that landed under the cursor and accepted
it would take the pointer off its own trigger and flicker itself closed and open
again. It sits above every popup, because what it names may be inside one.

A tooltip is visual only — it reaches neither touch nor a screen reader — so it
is never a control's name. Every trigger states its own.

## Disclosure

Three layouts of one idea: a trigger, and the thing it shows. `Tabs` lays the
choices side by side and swaps the panel under them; `Accordion` stacks them and
opens one in place; `Collapsible` is a single one of those with no list around
it. One group, `disclosure`, serves all three for the reason `field` serves the
control family — what differs is the arrangement, not what either is made of, so
the colour a closed row's label takes and the colour a tab you are not on takes
cannot become two decisions.

None of the three holds a value. A tab picks what is shown rather than what is
stored, so it takes no name, answers to no `Field.Root` and has no invalid
state — and it takes no well either. A strip borrowing the field's recess read
as a box with a second box in it: a rimmed slot in Lody Light, a black one in
Vesper.

### The strip

| part      | what it is                                                                   |
| --------- | ---------------------------------------------------------------------------- |
| track     | a flat tray: `disclosure.trackBackground`, no shadow, inset by `trackInset`  |
| indicator | the one thing standing on it: `disclosure.indicator` under `indicatorShadow` |
| tab       | the track's height less the inset on both sides, at the control type rule    |
| panel     | what the strip swaps, `disclosure.panelGap` under it                         |

The strip is a tray with one key standing on it. The tray is `trayBackground`, a
tint a step off whatever it sits on — ink at 6% in Lody Light, light at 6% in
Vesper — with no rim and no inner shadow, so it reads as one control rather than
as a box. The pill is `trayRaised`, the one raised thing, lighter than the tray
in both palettes: white in Lody Light, 21% in Vesper, where the plain raised rung
would sit level with a light tray. Any two-way strip a product builds itself
reads these two tokens too. The inset is 2px, so the pill
nearly fills the tray: a 32px strip holds a 28px pill, the small control height.
Nested radius applies: a 28px track at `radius.small` holds a 6px tab, a 32 or
36px one at `radius.medium` holds an 8px tab, and neither is a token of its own.

The indicator is one element that moves rather than a fill on each tab, because
the strip is one control and a pill sliding across it says so. It is drawn by
`Tabs.List` rather than by a caller, the way a submenu's chevron is drawn by its
row: a strip assembled without one is a segmented control with nothing
segmented. A tab therefore carries no fill in any state — what changes when you
take one is its colour, from `tabLabel` to `tabActiveLabel`, which is also where
a hover lands.

The size is stated once, on the strip. A tab's height, corner and share of the
width all follow from the track's, so a strip that takes the width on offer says
`stretch` and both facts move together — a track that stretched while its tabs
did not would be a full-width groove with the choices huddled at its start.

Arrow keys move without taking. A tab swaps a panel that may be expensive to
build, and arrowing to the fourth tab should not build the second and third on
the way; a surface whose panels are cheap says `activateOnFocus`.

### The stack, and the reveal

A row has no fill in any state: it is a line of a list rather than a control on
a surface, so what marks it is the `separator` the rules give a list, and what
moves when it opens is the chevron the part draws. One row is open at a time
unless the stack says `multiple`, because an accordion exists to keep a long
page short. A Collapsible has no list around it, so it takes neither the line
nor the row: its trigger is whatever the surface already had there, and the
panel is all the primitive owns.

What a panel holds is prose, so it takes the prose step rather than the control
step its trigger takes, and its padding rides on a **child** of the panel. That
is not a preference: Base UI animates the panel's height from a size it measures
with `scrollHeight`, which counts padding, so a padded panel is cropped by
exactly its own padding under `border-box` and overshoots by it under
`content-box`. A caller migrating a panel that carried its own padding moves it
inwards.

## Pressed

A control that stays pressed, a set of them, and the bar that holds them. One
group, `toggle`, covers all three for the reason `disclosure` covers three
layouts of one idea: what a pressed control looks like and how far apart two of
them stand cannot become three decisions in three files.

It is **not** the `field` group, and a Toggle is not a Switch. A Switch stores a
value in a form: it takes a name, answers to a `Field.Root`, can be invalid, and
is read as a setting. A Toggle says an option is on _right now_ — bold, wrapped
lines, this filter — so it has no name, no validity and no message under it.

| state    | what it is                                                                 |
| -------- | -------------------------------------------------------------------------- |
| off      | a ghost Button: no fill, `toggle.label`, `toggle.hover` under the pointer  |
| on       | the well rung: `toggle.pressedBackground` under `toggle.pressedWell`       |
| on hover | the rung mixed 4% toward the ink, the mix a secondary Button already uses  |
| focus    | 2px `toggle.ring`, composed onto the pressed edge rather than replacing it |
| disabled | `toggle.disabledOpacity` on the whole control, and the native attribute    |

**On is the well, not the accent**, and that is this family's one real
decision. The rules give a stored state the accent fill, and a toggle does
store one — but the accent is what a control that _already sits in a well_
becomes when it is on. A Switch's off state occupies the well, so on has to
leave it; a Checkbox's empty box is the same. A toggle rests on nothing at
all, so the well is still free, and sinking into it is the plainest thing this
system can say about a button that went down and stayed there. It also keeps a
bar of eight from reading as eight accent buttons, which is what the fill
would have made of it.

A toggle does not bob either. The motion rules give a press `translateY(1px)`
and a dropped highlight, and that is a raised thing going down and coming back;
this one goes down and stays, so what moves is the surface under it.

The ladder is `control`'s — 28, 32, 36, plus the 24 a file viewer's strip of
actions needs — rather than `Button`'s. A Button and a Toggle in one bar line up
because both read the same scale, not because one reads the other's group.

### The set, and the strip

A `ToggleGroup` is **not** a `Tabs` strip, and the two cannot be folded
together. A strip picks what a person _sees_: it is one control, so it is a
tray with one thing standing on it and one pill sliding between the
choices. A set stores what is _on_: two of its members can be pressed at once,
which no sliding pill can say, so it has no track and each member sinks on its
own. Asked for one choice out of several it still draws no track, because the
same set with `multiple` on has to look like itself.

The size and the shape are stated once, on the set, the way a tab strip states
them for its tabs. A set too wide for its row wraps; its members keep their
width there, because a toggle neither grows nor shrinks.

### The bar

A `Toolbar` draws **nothing at all**: no fill, no shadow, no radius, and not
even the line a table draws. It is a row of controls on whatever surface the
product already had there, so a bar inside a panel is not a second panel.

What it is for is the keyboard. A row of eight icon buttons is eight tab stops
unless something says otherwise, and a person tabbing through a page should pass
a bar rather than walk it: the bar is one stop, the arrow keys do the walking,
and a control that cannot be used is stepped over rather than stopped on. That
is the whole reason it is a part rather than a `div` with a gap.

Two gaps say what belongs with what. `toggle.groupGap` is between the members of
one set or cluster; `toggle.barGap` is between the clusters, and either side of
the line between two. The line is `Separator`'s, turned ninety degrees from the
bar, and the bar states that rather than the caller — a horizontal bar cannot
then end up with a horizontal line across it.

## Feedback

What the system says back: what happened, and that it is still working. One
group, `feedback`, covers both halves for the reason `field` covers a checkbox
and a select trigger — what changes between them is what they are made of, not
what they are for.

### Messages

An Alert and a Toast are one message on two rungs. An Alert stays on the page it
is about, so it takes the card rung; a Toast arrives over that page, so it takes
the floating one. Neither is on the modal rung: a message does not have to be
answered, and nothing behind it recedes.

| part        | what it is                                                                               |
| ----------- | ---------------------------------------------------------------------------------------- |
| mark        | `feedback.markSize`, in the tone's colour, drawn by the part                             |
| title       | what happened, at the control step, in `feedback.title`: 600 on an Alert, 500 on a Toast |
| description | the sentence under it, at the footnote step, in `feedback.description`                   |
| actions     | what answers it: Buttons, whose variants are the surface's choice                        |
| viewport    | a toast lands at the top, clear of the safe area, above every popup                      |

A tone is a **tint and a mark, never a fill** on an Alert, and **the mark alone**
on a Toast: toasts stack, and a stack of green, white and red cards reads as three
kinds of thing. Identical toasts collapse into one, and three show at most. There are four — neutral,
success, warning and danger — and the tint is 8% of the tone mixed into the
rung's own background, which is the mix a destructive menu row already uses. It
is mixed in `feedback/surface.ts` rather than frozen into a token, because it is
a mix _of a surface_ and the two surfaces are on different rungs.

Neutral is the one tone with no colour of its own: `accent` is the obvious
candidate and the rules reserve it for live state, so a neutral message takes
`secondaryLabel` for its mark and lets the words do the work. It still takes a
tint, toward `label`, because an Alert is the one part of this family that
shares its rung with what it sits on — a card inside a card is the same fill
twice, and in the light palette the card rung and the page are one white.

The mark belongs to the tone rather than to the caller, the way an accordion's
chevron does: the point of a tone is that a person knows what kind of message
this is before reading it, and a glyph a caller chose can put a tick on a
failure. The warning is the one that is not a circle, because a triangle is what
separates it from an error for a person who does not see the two colours apart.

How urgently a message is announced follows from its tone as well: `alert` for a
failure or a warning, which interrupts, and `status` for the rest, which waits
its turn. A surface that had to choose would choose `alert` every time, which is
the version that teaches people to ignore it.

### Waiting

| part     | what it is                                                                    |
| -------- | ----------------------------------------------------------------------------- |
| track    | `feedback.trackBackground` under `feedback.trackWell`, `trackHeight` tall     |
| bar      | `feedback.indicator` — `accent`, because the rules name the running indicator |
| no value | the same track with a band crossing it, not a bar at zero                     |
| skeleton | `feedback.skeleton`, a gray, because it has no role yet                       |
| spinner  | `currentColor`, so it belongs to whatever holds it                            |

A bar that reports an outcome rather than progress takes that outcome's tone,
and one that measures something rather than progressing through it — a quota, a
share of storage — takes `neutral` and gives the accent back. Ink is never the
answer here: ink is for a value that is stored, and a bar in motion is the
opposite.

A skeleton breathes rather than sweeping, because a page of sweeping blocks is a
page of movement, and it stops where a person has asked for less of it — it
reports nothing its own shape does not already say, which is also why it is
hidden from a screen reader. A spinner keeps turning there, because it is the
only thing saying the work has not stopped.

## Tables

Rows of records, and the way to the rows that did not fit. One group, `table`,
covers both for the reason `dialog` covers three modals: a pager exists because
a table did not fit, the two sit on the same rung and state the same size, and
how dense a list of records is has one place to change rather than two.

A table is the one part of this system with **no surface of its own**: no
background, no shadow, no radius. It is rows on whatever the surface around it
already was — a page, a card, a dialog — so the card that holds one keeps owning
its edges, and a table inside a card is not a card inside a card. What it draws
is the one edge the rules give a list: `separator`, between one row and the next.

**A column is stated once.** How wide it is, which way it aligns, whether it
holds figures, whether the table can be ordered by it, what a totals row holds
under it — these are facts about a column, and a column written twice (a name in
the head, a cell in every row) is a fact that can drift. Everything below
follows from stating them in one place; a table that is not a list of records —
a two-column list of facts, a Markdown document's markup — assembles the
elements instead and gets none of it.

| part     | what it is                                                                    |
| -------- | ----------------------------------------------------------------------------- |
| row      | a `table.rowHeight*` row on the control ladder; the height is a floor         |
| line     | `table.line` under a row, and none under the last one                         |
| head     | a column's name, at the footnote step in `table.head`: about the column       |
| cell     | the value, at the control step in `table.value`, on one line                  |
| numeric  | tabular digits, aligned to the end of the column                              |
| sorted   | the one column at `table.headActive`, with the arrow the part draws           |
| hover    | `table.hover`, and only where pressing a row does something                   |
| selected | `table.selected`, under the tick that is what actually says so                |
| stayed   | a head over its own scroll box: `table.headStickyBackground`, the region rung |
| stacked  | too narrow for columns: label and value per line, `table.head` on the label   |
| nothing  | `table.emptyHeight` of `table.empty`, across every column, head still up      |
| caption  | what the table is, under it, at the footnote step in `table.caption`          |

The head takes the line too. The rule against a line under a header is about a
heading over a surface; a row of column names is the row before the first
record, and the line under it is the divider to the next row that `separator` is
for. The last record draws none, because there is no next row there.

The line is the `inset 0 -1px 0` every other row in this system draws, and the
table is laid out with `border-collapse: separate` so that it can be. Under
`collapse` a row's box-shadow is not painted, a sticky head's border does not
travel with it, and a row could not carry a focus ring; under `separate` all
three work and a row keeps **one** box-shadow in which its line and its ring
compose, which is the rule every other control here already follows.

The two fills are the palette's own `hoverFill` and `selectedFill` rather than a
mix of the surface, which is the opposite of what a popup row does. Those two
were tuned against the page and card rungs, and a table row is exactly the row
this table names them for; a popup derives its own only because on the floating
rung they collapse into the surface.

The pointer is answered **only where pressing a row does something**. A table of
facts is read, not operated, and a row that lights up and does nothing when
pressed is a promise the table cannot keep. A row that can be pressed takes the
keyboard with it — Enter and Space press it, and the ring says where the
keyboard is. Selection is a **tick** first: `aria-selected` belongs to a row in
a grid, so a table that lets a person pick rows puts a checkbox in one, which is
both what they press and what announces it, and the fill is how they find those
rows again down the page. The box over that column is derived, never passed:
none, some — which is `mixed` — or all.

A column's name is a control only where the table can be ordered by it, and then
it is a real button with the ring every control here takes. Which way it is
sorted is on the cell as `aria-sort`, so what a screen reader is told and what
the arrow shows are one fact, and **one column wears the arrow at a time**. The
table does not reorder the records: a server sorts, a comparator breaks ties, a
page is one slice of many, so the control is the primitive's and the data is the
surface's.

A head stays only where the table owns a box to stay in — a height and a sticky
head are one decision, because a head that scrolls out of its own box is not
something a surface would ask for. A head that stays is no longer a row: it is a
band over the rows moving under it, so it takes the rung the ladder gives a band
over the page. That is not decoration; a transparent one has the records painted
through the column names.

### Too narrow for columns

A table narrower than its columns need is not a table with a scrollbar: it is a
list of records, each one a stack of label-and-value lines, with the label
taking the head's colour and step. It is the head's own words rather than a
second copy of them — which is reachable only because the columns were stated.

The question is about **the table's own width**, not the window's. A settings
table in a 360px side panel on a 27-inch screen is narrow, and a breakpoint
calls it wide; the panel is the thing that got small. So it is a container
query, and the width at which it stacks belongs to the system rather than to a
caller: a caller choosing it is a caller deciding how wide a record may be.

### The pager

The window is one width from the first page to the last, so the buttons do not
move out from under the pointer, and a gap is drawn only where it stands for
more than one page — a gap hiding a single page is wider than the page it hides
and costs the press that page would have taken. Against either end the gap that
is not needed is spent listing more pages instead.

The page a person is on says so twice: a secondary Button among ghosts, and
`aria-current`, because the fill reaches only the people who can see it. The
steps either way are disabled at the ends rather than removed, since a pager
whose buttons come and go moves the ones beside them. Nine thousand pages are
not a list, so a pager that long says where you are instead — `table.pagerHint`
for the count, the label colour for the number — and lets a person type it.

## Cards, badges and lines

Three answers to "what is an edge?". A card's is a shadow, a badge has none and
is a film of ink instead, and a separator _is_ the one line this system allows.

### Card

The card rung made a component: `card.background` under `card.shadow` at
`radius.large`, and no border. Its parts are a Dialog's — a header, the body a
caller writes, and the answers — because what separates a panel that owns the
window from a block that owns a region of a page is the rung and the heading
step, not what either is made of. It keeps its own group rather than reading
`dialog`, for the reason a menu does not read `field`: two rungs, two names.

| part        | what it is                                                                     |
| ----------- | ------------------------------------------------------------------------------ |
| card        | `card.padding` in, children at `card.gap`, and no edge but the shadow          |
| header      | the title and one sentence about it, at `card.headerGap`: one block            |
| title       | `headline`, weight 600 — a card does not own the window, and `title` is a page |
| description | prose at `card.descriptionSize` in `card.description`                          |
| footer      | the answers, from the end at `card.footerGap`; reversed when narrow            |
| interactive | the pointer's answer, `card.hover`, and nothing else                           |

A card does not nest. Two of them one inside the other are the same fill twice
in the light palette, where the card rung and the page are one white; a block
inside a card is the region rung, which a surface lays out rather than asks for.
It renders no control either: `interactive` marks the card and the caller brings
the button, because what a press does is a product decision.

The ladder names the region rung for "hover on a card", and measured in the dark
palette that is the card rung's own value — `elevatedBackground` and
`secondaryBackground` are both `hsl(0 0% 8.6%)`. So `card.hover` mixes the rung
toward `label` at 4%, the derivation `popup.highlight` and a secondary Button's
hover already use, which steps away from the surface in both palettes at once.

### Badge

A standing fact about the thing beside it, and the one part of this system on
**no rung**: it sits on a page, a card, a menu row or a modal panel, so it can
take no background from the ladder. Its fill is a _film_ — the tone at 12% of
`label` or 22% of a tone over whatever is underneath, the form a destructive
ghost Button's hover already takes — so one declaration reads on every rung and
in both palettes. Those two started at 8 and 14, which was a film too thin to
tell apart: the closest pair of tones measured 0.019 apart in oklab in the light
palette and 0.026 in the dark one, and is now 0.030 and 0.035.

**The word carries the tone, and it is the tone pulled halfway to `label`.**
The raw tone cannot: `warning` is 2.8:1 on a near-white surface, a colour tuned
for a 16px mark where the bar is 3:1, used as 11px text where it is 4.5:1. But
the raw tone is not the only way to carry a hue. At half the distance to the
ink, a tone keeps its hue and gains the ink's contrast — the worst of the four
measures 5.2:1 on its own chip, on every rung, in both palettes.

The film alone could not do this. A 20px chip's tint is a wash a few percent off
its surface; its word is the mark a person looks at. The four words land 0.097
apart in oklab at the closest in the light palette and 0.048 in the dark one,
against 0.030 and 0.035 for the films under them. The dark palette is where it
earns its place: there `accent` is a pale peach and `warning` an amber, twenty-six
degrees apart, so their films are two brown washes that no percentage separates,
and their words are a peach and a gold at four times the chroma.

Half is not a round number chosen for tidiness. At 60% of the tone the worst word
is 4.2:1 — under the bar on the floating rung, where the chip is already a step
darker — and at 40% the hues wash out.

`badge.label` is the neutral word and the ink the rest are pulled toward: `label`,
not `secondaryLabel`. A badge's word sits on the badge's own film rather than on
the page, and there `secondaryLabel` was 3.9:1 on a danger chip and 3.4:1 inside
a popup — under the bar before the films were strengthened, not because of it.

It is metadata, so it takes the caption step the rules give a row's trailing
metadata — which is how it stays quieter than the thing it is attached to, by
size rather than by a colour that cannot carry its own words — at `radius.mini`
and `badge.height`, with figures at one width. It neither grows nor shrinks: a
surface that must cap a long one caps the badge, because a chip that shrank
would be clipped by a tight row rather than by a decision.

Five tones: the four a message reports, and `running`, which `Progress` adds for
the same reason — a machine being reached is live state, which is what `accent`
is for. There is no hover, no focus ring and no pressed state. A chip that
answered a pointer would be a Button, and the deleted implementation's filled
`default` variant — ink, which the rules give a stored value — invited exactly
that press.

### Separator

`separator`, 1px, between the rows of a list or a table. It has no token group:
every other component derives its edge from tokens that say which rung it is on,
and this one _is_ the edge, so a `separator.color` pointing at the semantic
token would be a second name for one fact.

It is announced. Base UI renders `role="separator"` with the orientation, and
there is no `decorative` escape hatch: a line here is never decoration, because
the one place it is allowed is structural. Where it sits in a stack is the
surface's layout, so it carries no margin of its own — a popup's divider has one
only because it bleeds through an inset the caller cannot see. A vertical line
stretches to its row rather than taking a percentage of a height the row has
not got.

## Faces and keys

Two parts that stand for something outside the interface — a person, and a key
on the keyboard — and neither is a control. They take the gray ramp, which is
what the rules reserve it for: a thing with no role.

### Avatar

The second part on no rung, and the one that is **not a film**. A badge can be a
tint over whatever holds it because a word reads through one; what an avatar
stands in for is a photograph, and a translucent face would show a row's hover
through it. So the fallback is `avatar.fallbackBackground`, a gray, the same
reading `Skeleton` already takes.

| part    | what it is                                                             |
| ------- | ---------------------------------------------------------------------- |
| box     | one of five rungs — 16, 20, 24, 32, 64 — a width, a height, and a crop |
| picture | fills the box and is cropped to it; mounted only once it has loaded    |
| letters | the rung's own step, in `avatar.fallbackLabel`                         |
| mark    | an `avatar.glyph*` box, for a name there are no letters to make        |
| circle  | a person: `radius.full` on `corner.round`                              |
| tile    | a thing: `avatar.tileRadius*`, the radius-by-size table read per rung  |

**The rung picks the letters.** A box and a type step stated separately are two
facts that can disagree, and they did: the deleted implementation had one size
and twenty call sites restating both. Two initials want 20px or more; 16 is a
face where an icon would otherwise be.

A circle is a person and a tile is a thing. A circle around a logo is a crop,
and the mark inside one was drawn square. The letters take `label` rather than
`secondaryLabel` — unlike a badge's word, which is _about_ the thing beside it,
initials **are** the person, and measured on this gray the secondary label is
3.5:1 in the light palette, under the 4.5:1 letters this small need.

An avatar is a ceiling as well as a floor. A flex item's automatic minimum size
is its content's, so a 16px circle holding two initials lays out 20px wide and
stops being a circle; the box and the fallback both give that up, and the
letters are clipped to the width instead.

An identity colour — a hue derived from a name, so one workspace is one colour
on every screen — is the surface's and arrives as a `style`. Which hue belongs
to which name is a product fact, not a token.

### Kbd

`kbd.background`, a gray, at a badge's height and corner: a cap stands for a
piece of hardware, so `accent` would claim it is live, ink would claim it is
stored and a tone would claim it reported something. It is never a control —
no hover, no focus ring, no pressed state, and it takes neither the pointer nor
a selection. A chord is a `<kbd>` around `<kbd>`s at `kbd.gap`, with nothing
between them: a `+` is how a chord is written in prose, and this is not prose.
One cap is at least as wide as it is tall, so `K` and `Shift` do not read as
noise side by side. The face is the UI font, because `<kbd>` defaults to
monospace and `⌘` there is a different glyph from the identical character in the
label beside it.

A menu row's shortcut is **not** this: the rules give that slot plain trailing
metadata in `popup.hint`, because a column of chips down a menu's right edge
turns a quiet list into a keyboard diagram. A cap is for where the keys are the
subject.

A cap on a tooltip is the same cap. The tooltip is on the floating rung, so a
cap there stands on a raised surface like a cap in a command palette does, and
nothing re-declares what it is made of.

## Material

Flat, with a light above it. Nothing here is a picture of a material: no grain,
no noise, no gloss, no reflection, no deep groove. What is physical is the logic
of the light, and it takes four rules.

- **Raised catches the light.** A thing you can press is at least as light as
  what it rests on, never a mid-gray on a gray: in Lody Light `raisedBackground`
  is white, the same white as the card and modal rungs, so a secondary button,
  a switch thumb and a tab's pill read by their edge and their lift rather than
  by a fill. A gray raised part under a soft shadow is what reads as grime.
- **An edge is crisp; a lift is short.** Every lifted shadow is three layers: a
  0.5px hairline, a contact shadow within 1–2px, and a lift whose negative
  spread keeps it under the object instead of haloing round it. Dark palettes
  draw the hairline in light (`white` at 6–10%) and keep the inset top highlight,
  because a dark shadow does not read on a near-black page.
- **A field is a shallow recess.** `shadow.inset` is a short shadow inside the
  top edge, one inner hairline and a lit lower lip, over a fill just under the
  surface. Depth comes from the light, not from a gray fill: a mid-gray well on a
  white card read as a hole.
- **Light falls off down a raised face.** `sheen.raised` and `sheen.ink` are that
  fall-off as a `background-image` over the fill, a few percent at most, so a
  hover that changes the fill keeps it. A press drops it: a thing pressed flush
  faces the light no more than the surface around it.

| token          | on                                                  |
| -------------- | --------------------------------------------------- |
| `sheen.raised` | secondary button, switch thumb, tab indicator       |
| `sheen.ink`    | primary and destructive button, checked box / radio |

A secondary button pressed keeps its hairline and gains a one-hair inset rather
than dropping every edge: on the white card rung it is otherwise white on white
under the finger.

## Corners

- `corner.shape` (squircle) on every radius except `radius.full`. Round fallback
  outside Chromium.
- `radius.full` is a pill or a circle, and takes `corner.round`. A squircle at
  that radius is a superellipse, not a stadium: it turns a switch track into a
  rounded rectangle and a radio into a squircle.
- Radius by size: `mini` 5 for 16px things, `small` 8 for 28px controls and
  tooltips, `medium` 10 for 32 and 36px controls, `large` 14 for surfaces.
- Nested radius is outer minus inset. A 14px popup with 4px inset holds 10px
  items. Never the child's own token.
- Icon-only buttons are square at the size's height, and hold a 16px glyph:
  the button draws that box, because a glyph here fills whatever holds it.

## Type

- Controls at 13 (`subheadline`), weight 500, `text.controlTracking`.
- Prose at 14 (`body`), weight 400. Field labels and help at 12 (`footnote`).
- Dialog title is `headline`; `title` is for a full page.
- Sizes: 28 / 32 / 36. Default 32. 36 only for empty states and onboarding.

## Motion

- Press: `translateY(1px)`, drop the lift and the sheen, `duration.fast`. Ink
  and tone fills drop `shadow.inkEdge`; a secondary keeps its hairline.
- Rise: popups from 4px below at opacity 0, `duration.regular`.
- Colors and fills cross-fade at `duration.fast`. One easing: `ease.standard`.
- Except a popup row's highlight: it is instant. It follows the pointer and the
  arrow keys, and a fade leaves it behind the row they are already on.
