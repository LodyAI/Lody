# Shared UI primitives

Status: draft
Translation: pending

## Scenario

A person should encounter the same control language across Lody's desktop and
web surfaces. Buttons with the same role should share appearance, state feedback,
and theme behavior even when they are composed by different product features.

## Responsibilities

`@lody/ui` owns reusable visual primitives and semantic design tokens. A primitive
exposes named product choices instead of asking each caller to assemble its
colors, dimensions, radius, shadow, and interaction states.

The Button supports primary, secondary, ghost, destructive, and link variants;
mini, small, medium, and large sizes; icon-only controls; destructive tone; and
default or pill shapes. These choices define the redesigned interface. Migrated
callers must not reproduce the appearance of the deleted Button implementation.

A field is a composition rather than a single control. A field root owns the
control's name, whether it is disabled, and whether it is valid; the label, the
control, the help text, and the error message read that state from the root
instead of receiving their own copies of it. A caller therefore states a field is
invalid in one place, and cannot leave a control and its message disagreeing.
The composition provides a text input in small, medium, and large sizes, a
multi-line control, a checkbox, a group of radio options, and a switch, and
associates the label with the control without the caller naming an identifier.

The composition also provides a control that picks one value from a list the
person opens, and one that filters that list as they type. These are two parts:
the control a person sees at rest sits with the rest of the family and answers to
the field root the same way, and the list it opens is a floating surface with its
own appearance. A person reaches the list with the keyboard, walks it with the
arrow keys, and takes a row with Enter; the row that holds the value is marked so
they can see which one it is, and the row they are on is marked separately,
because those are two different facts. A list that is open reports what it is to
a screen reader, and a control tells one which list it opens.

A surface that owns a modal states where the popups inside it belong. A modal
holds the keyboard and the scroll inside its panel, so a list that opens outside
that panel is unreachable in it; the surface names the panel once and the lists
under it follow. Product surfaces do not otherwise place these lists.

The same floating surface also carries commands. A person reaches a menu three
ways — a control that opens one, a right click or long press over a region, and
a bar of names along the top of a window — and meets the same commands whichever
way they came: one row, one height, one mark for where the keyboard is. A menu
holds commands, commands that toggle a setting, commands that pick one of a set,
headings over groups of them, and commands that open a further menu; a command
may carry a glyph, a keyboard shortcut, and the fact that it destroys something,
which it states in its own colour rather than only in its words. A command that
toggles a setting leaves the menu open so a second can be toggled; a command that
acts closes it. A person walks a menu with the arrow keys, opens a further menu
from the row that owns it, and leaves with Escape; the row the pointer is on and
the row the keyboard is on are one row, and a row that cannot be used is neither
reached nor run.

The list a control opens is as wide as that control, because the control shows
the value the list holds. A menu is opened by whatever the surface already had
there, so it states a width of its own. Where keyboard focus goes after a menu
closes is a product decision — a surface may want the composer rather than the
control that opened the menu — so the surface states it and the primitive does
not choose for it.

That same floating surface also carries content rather than rows or commands: a
small panel a control opens, with a heading, a sentence about it, and whatever
the surface puts under them. It is one surface with three things on it rather
than three surfaces, so a panel and the menu beside it cannot open at two radii
over two shadows. What it holds is prose, so its text follows the prose rule
rather than the rule a row's label follows.

A surface that must be answered before a person carries on is a panel over the
whole window, with the page receding behind it. There are three, and they are
one thing arriving three ways: one a person may dismiss, and which shows that it
can be; one that must be answered, where a press beside it is not an answer,
although the key that cancels still is; and one that arrives from an edge of the
window rather than its middle. All three share one appearance, so a padding or a
heading has one place to change. Each states its own panel as the place the
lists and menus inside it belong, so a surface that opens one never has to.
Which answer in such a panel is the affirmative one, and what it is about, is
the surface's decision rather than the panel's.

The one that arrives from an edge can also be sent back to it. A panel sliding in
from an edge promises that gesture, and a person using a touch screen will make
it, so that panel is a different thing from the one in the middle rather than the
same thing repositioned: it is laid out against the edge it belongs to instead of
placing itself, which is what leaves it free to follow a finger. It names that
edge in reading order rather than as left or right, and the direction that sends
it away follows from the edge, so a panel on the leading side departs the way
"away" means in the reader's language. It either meets the window — reaching the
physical edge, squaring the corners that touch it, and keeping its own contents
clear of whatever the device intrudes — or floats clear of every edge as an
object resting over the page. As it is dragged away the page behind it returns in
proportion, so a gesture half-made reads as one that can be abandoned. A shell
that wants the page itself to recede while such a panel is open says so around
its own interface; the panel does not reach out and do it.

A person may also be told what a control is without acting on it. That label is
not a surface a person visits: it is a mark over the thing it names, so it reads
inverted rather than raised, it never takes the pointer, and it sits above every
other floating thing because what it names may itself be on one. It is offered
to sighted people using a pointer or a keyboard and reaches neither touch nor a
screen reader, so it never carries a control's name — every control it describes
states its own name, and a surface that groups several of them lets the second
appear without the wait the first had.

A surface may also show one thing out of several, and there are three ways it
does so: the choices side by side with the thing under them, the choices stacked
with the thing opening in place beneath the one chosen, and a single such thing
on its own. These are one family rather than three components, because each is a
control that says what is shown and a region that shows it; only the arrangement
differs. None of them holds a value — what they pick is what a person sees, not
what is stored — so none takes a name, a validity or a field around it.

The strip of choices is a sunken track with the chosen one raised out of it, and
that mark is one thing that moves between the choices rather than a light that
turns on under each, because the strip is a single control. It is provided by
the strip itself rather than assembled by a surface. The choices are stated
once at a size, and a strip told to take the width it is offered divides that
width between them. Moving along the strip with the keyboard does not take a
choice, because what a choice reveals may be expensive to produce; a surface
whose regions are cheap may ask for the opposite.

A stacked choice is a row with no fill of its own, separated from the next by
the line the system gives a list, and it says what it hides with a mark that
turns over as it opens. One is open at a time unless the surface says otherwise.
A lone one has no list around it, so it has neither that line nor that row: it
is opened by whatever the surface already had there. What opens is animated from
its own measured height, so what it holds keeps its spacing on something inside
it rather than on the part being measured.

The system also speaks back. What it says is either what happened or that it is
still working, and those are one family rather than five components. A message
is the same block wherever it appears — a mark that names what kind of message
it is, what happened, a sentence about it, and whatever answers it — and it
appears in two places: kept on the page it is about, or arriving over that page
and leaving on its own. Neither takes the whole window, because a message does
not have to be answered before a person carries on.

A message reports one of four things: something worth knowing, something that
worked, something that may still go wrong, and something that failed. The
palette names three of them; the fourth is deliberately unnamed, because the
colour that would suggest itself is reserved for live state. What it reports
colours its mark and tints the surface under it, and never fills it. The mark
belongs to what is being reported rather than to the surface that reports it, so
a failure cannot be shown with a tick. How urgently a person using a screen
reader is told follows from the same fact: a failure interrupts, a confirmation
waits its turn.

The other half is the wait. A bar shows how far something has got, in the one
colour this system gives to live state; a bar with no value to show is not a bar
at zero but the same bar saying it does not know, which is a different report. A
bar that measures something rather than progressing through it gives that colour
back. A stand-in for content that has not arrived says nothing to a screen
reader, because its shape already says it, and it stops moving where a person
has asked for less movement — while the mark that says work is under way keeps
turning there, since it is the only thing saying the work has not stopped.

Not everything on a surface reports or acts. Three things say what a page is
made of while nothing is happening: a block that groups what belongs together, a
word that states a fact about the thing beside it, and a line between the rows
of a list. Each answers the question this system asks of every part — what its
edge is — differently. The block's edge is the shadow that lifts it off the page.
The word has no edge and no place on the ladder at all: it appears on a page, on
a block, on a row of a list a person has opened and on a panel over the window,
so what it is filled with is a film of its own colour over whatever it happens
to sit on. The line is the edge, and it is the only one the system allows: it
divides rows, never encloses a surface and never underlines a heading, and it
says what it is to a screen reader rather than pretending to be decoration.

A block is a panel one step nearer the page than the one that must be answered,
and it is made of the same parts: a heading, a sentence about it, what a person
came for, and the answers. It does not contain another of itself, and it is not a
control — a surface may say that pressing the block does something, and then the
surface provides what is pressed, because what a press does is the product's
decision and not the block's.

A word that states a fact says what kind of fact by tint alone, never by
colouring the words: the colours this system gives to outcomes are tuned for a
mark the size of a glyph rather than for text this small, and a word is never
wordless, so the tint can carry the kind while the word carries the fact. It
reports the same four outcomes a message does, and one more — that something is
happening now — because that is live state and the system has a colour for it.
It is never a control: nothing about it answers a pointer or takes focus, and a
surface that needs those needs a button.

Every control in this family shares one set of state appearances: a sunken
resting surface with no border, a placeholder in the hint colour, an accent ring
on focus, a destructive ring while invalid that persists when the control is
focused, and reduced opacity on the whole control when disabled. The states are
defined once for the family, so a control added later inherits them rather than
choosing its own.

A control that stores a value — a ticked checkbox, the selected radio option, a
switch that is on — shows that as ink, because the accent colour marks live
state rather than a stored one. A checkbox can also stand for a partial
selection, which it announces as mixed rather than as ticked. Each of these
controls is a button to the platform: the keyboard reaches it, a screen reader
is told which kind of control it is and whether it holds a value, and a form
receives that value under the name the field root gave it.

Product surfaces own workflows, placement, responsive layout, and accessibility
requirements. They may add layout or interaction classes when a local constraint
cannot be expressed by the primitive, such as a 44 px touch target in the Mermaid
viewer. Those classes must leave the primitive's visual identity under its props.

## Theme behavior

Semantic StyleX tokens provide light and dark values. A theme applies to a subtree
so a primitive responds without product code selecting raw palette values. Token
names describe meaning and interaction role; component tokens derive from those
semantic values or documented fixed dimensions.

A forced theme applies to the subtree it is placed on, including the primitives
inside it. A component token that derives from a semantic colour resolves against
the palette in force on that subtree, not the palette of the document root, so two
palettes can be shown at once on one page.

## Gallery

`@lody/ui` carries a gallery of its own tokens and primitives. It presents each
semantic token, each elevation rung, and each state a primitive exposes through
its props, rendered in both palettes from the tokens themselves rather than from
copied values. The gallery is the reference a person reads when choosing a token
or a prop, and the place a new token or primitive state becomes visible; a token
that no sample presents is a gap the package reports.

## Migration

Primitives move from `@lody/components` one at a time. A legacy primitive is
removed once all in-repository callers use the new package and type checks show no
remaining dependency. The migration does not expose an adapter for old Button
variants or sizes. A primitive arrives with the state appearances its family
already defines; it does not introduce a second colour or state vocabulary for a
state the family has decided.

## Evidence

Intended behavior: Issue [#304](https://github.com/LodyAI/Lody/issues/304) and PR
[#305](https://github.com/LodyAI/Lody/pull/305).

Inspected implementation: `packages/ui/src`, package compiler configuration, and
migrated Button consumers in `packages/components`, Electron, and site docs.

Executed validation is recorded in the linked PR and its
[Agent Note](../.agents/notes/implemented/architecture/2026-09-08-ui-button-migration-takeover.md).

The gallery and the subtree palette behavior are recorded in the
[UI token gallery note](../.agents/notes/implemented/feature/2026-09-09-ui-token-gallery.md).
The field composition, the state mapping it settles, and the outstanding focus
ring suppression in the desktop shell are recorded in the
[UI field primitives note](../.agents/notes/implemented/feature/2026-09-09-ui-field-primitives.md).
The checkbox, radio and switch that join that family, and the ink they use for a
stored value, are recorded in the
[UI choice controls note](../.agents/notes/implemented/feature/2026-09-10-ui-choice-controls.md).
The select and the combobox, the separate token group their lists take, and the
container a modal names for them are recorded in the
[UI select and combobox note](../.agents/notes/implemented/feature/2026-09-10-ui-select-combobox.md).
The menu family that shares that surface, the one declaration it replaces, and
the migration of the Radix menus still owed to it are recorded in the
[UI menu primitives note](../.agents/notes/implemented/feature/2026-09-11-ui-menu-primitives.md).
The popover on that same surface, the modal rung the dialog family shares, the
inverted tooltip, and the migration still owed to them are recorded in the
[UI overlay primitives note](../.agents/notes/implemented/feature/2026-09-12-ui-overlay-primitives.md).
The three disclosures and the height a reveal animates are recorded in the
[UI disclosure primitives note](../.agents/notes/implemented/feature/2026-09-12-ui-disclosure-primitives.md);
the messages, the waits, and the toast migration deferred with them are recorded
in the
[UI feedback primitives note](../.agents/notes/implemented/feature/2026-09-12-ui-feedback-primitives.md).
The card rung as a component, the badge that is on no rung, the one line the
rules allow, and the Card callers still owed a flush surface are recorded in the
[UI card, badge and separator note](../.agents/notes/implemented/feature/2026-09-12-ui-card-badge-separator.md).
