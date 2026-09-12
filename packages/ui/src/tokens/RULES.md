# Token usage rules

Construction: depth without lines. No border token exists. Surfaces separate by
luminance step and shadow; controls are wells (sunken) or raised.

## Elevation ladder

One rung per component. The rung fixes background and shadow together.

| rung     | background            | shadow                     | examples                                                                          |
| -------- | --------------------- | -------------------------- | --------------------------------------------------------------------------------- |
| well     | `wellBackground`      | `shadow.inset`             | input, select, textarea, switch off, checkbox off, segmented track, selected item |
| page     | `background`          | none                       | app ground                                                                        |
| region   | `secondaryBackground` | none                       | sidebar, footer band, hover on a card                                             |
| card     | `elevatedBackground`  | `shadow.card`              | card, panel, composer                                                             |
| floating | `raisedBackground`    | `shadow.popover`           | menu, popover, select list; tooltip is `label` with `shadow.medium`               |
| modal    | `elevatedBackground`  | `shadow.large` + `overlay` | dialog, alert dialog, drawer                                                      |

## Edges

- `separator`: next row. Dividers between list and table rows only. Never
  around a surface, never under a header.
- well: you can put something here. `wellBackground` + `shadow.inset`.
- raised: you can press this. `raisedBackground` + `shadow.raised`. Primary and
  destructive buttons are raised with `shadow.inkEdge` as their top highlight.
- shadow: above the page. Strength by rung.
- ring: attention here. A 2px `box-shadow` composed with the control's own
  shadow, tight to it, no offset, no glow. `accent` on focus, `destructive` on
  invalid. Not an `outline`: the product shell resets outlines with `!important`.

## Color

- `label` is the thing, `secondaryLabel` is about the thing, `tertiaryLabel`
  is a hint: placeholder, help text, chevron, icon at rest.
- Ink for stored state: primary button, checked, on. `label` fill,
  `background` text.
- `accent` for live state only: focus ring, link, live switch, running
  indicator. Never a button fill.
- Disabled is 45% opacity on the whole control, not a color.
- Semantic first, gray second. `gray…gray6` only for things with no role:
  scrollbar, tracks, kbd, skeleton.

## Fields

A control is the well rung: `wellBackground` plus `shadow.inset`, never a
border. One component token group, `field`, serves the whole family — input,
textarea, checkbox, radio, switch and the Select and Combobox triggers — so a
state has one colour in one place instead of one per component. The lists those
triggers open are on the floating rung and read `popup` instead; see below.

| state       | what it is                                                                     |
| ----------- | ------------------------------------------------------------------------------ |
| rest        | `field.background` and `field.well`; the value in `field.value`                |
| placeholder | `field.placeholder`, the hint colour; it is a prompt, not a label              |
| focus       | 2px `field.ring` (accent), tight to the control, no offset                     |
| invalid     | 2px `field.invalidRing` (destructive), at rest and while focused               |
| disabled    | 45% opacity on the control; the label and help dim with it                     |
| checked, on | ink: `field.checkedFill` under `field.checkedMark`, `field.checkedEdge` on top |
| mixed       | the checked appearance with the dash, and it announces `mixed`                 |
| selected    | the tick, and a quiet fill on the row that is current, not on the control      |

A checkbox and a radio are the "16px things" the corner rule names: a
`field.boxSize` box at `radius.mini`, round for a radio. A switch is a
`field.switchWidth` by `field.switchHeight` track at `radius.full` holding a
`field.thumb` thumb raised with `field.thumbShadow`, the same height as the box
so a settings row carrying both lines up. Off is the well; on is the ink, which
is where the well's shadow gives way to `field.checkedEdge`. Because CSS cannot
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
the page and card rungs at 100% lightness. Measured on the floating rung,
`hoverFill` lands 2/255 from `raisedBackground` in the light palette and
`selectedFill` resolves to exactly `raisedBackground` in the dark one, so one
state is invisible in each. Mixing `raisedBackground` toward `label` steps away
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

The one floating thing that is not the popup surface: `tooltip.background` is
`label` and `tooltip.label` is `background`, under `shadow.medium` at
`radius.small`. That inversion is deliberate. A popup is a place to act; a
tooltip only names what is already under the pointer, and it has to read at a
glance over whatever it covers without becoming another surface competing for
attention. A tooltip reaching for `popup.background` would be naming the wrong
thing to get the wrong colour.

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
state; it borrows the well the controls sit in because the ladder puts it there,
not because it is one of them.

### The strip

| part      | what it is                                                                       |
| --------- | -------------------------------------------------------------------------------- |
| track     | `disclosure.trackBackground` under `disclosure.trackWell`, inset by `trackInset` |
| indicator | the one thing raised out of it: `disclosure.indicator` under `indicatorShadow`   |
| tab       | the track's height less the inset on both sides, at the control type rule        |
| panel     | what the strip swaps, `disclosure.panelGap` under it                             |

The strip is the ladder read twice over — a well with one raised thing in it,
the same pair a Switch takes — and it says the same thing: the track is where
something sits, and the thing sitting in it is the one you can press. Nested
radius applies: a 28px track at `radius.small` holds a 4px tab, a 32 or 36px one
at `radius.medium` holds a 6px tab, and neither is a token of its own.

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
- Icon-only buttons are square at the size's height.

## Type

- Controls at 13 (`subheadline`), weight 500, `text.controlTracking`.
- Prose at 14 (`body`), weight 400. Field labels and help at 12 (`footnote`).
- Dialog title is `headline`; `title` is for a full page.
- Sizes: 28 / 32 / 36. Default 32. 36 only for empty states and onboarding.

## Motion

- Press: `translateY(1px)` and drop `shadow.inkEdge`, `duration.fast`.
- Rise: popups from 4px below at opacity 0, `duration.regular`.
- Colors and fills cross-fade at `duration.fast`. One easing: `ease.standard`.
