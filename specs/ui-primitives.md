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
