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
The composition provides a text input in small, medium, and large sizes and a
multi-line control, and associates the label with the control without the caller
naming an identifier.

Every control in this family shares one set of state appearances: a sunken
resting surface with no border, a placeholder in the hint colour, an accent ring
on focus, a destructive ring while invalid that persists when the control is
focused, and reduced opacity on the whole control when disabled. The states are
defined once for the family, so a control added later inherits them rather than
choosing its own.

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
