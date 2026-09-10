# Cross-machine plain chat and visible unavailable Roles

Status: implemented
Translation: pending

## Abstract

Role mentions previously hid unavailable Roles and restricted plain chats to
one machine, making remote Roles disappear without explanation. Plain chat now
uses the authorized-machine scope, while the menu retains all readable Roles
and puts disabled matches after available ones with a reason below their name.
Filesystem-bound projects retain their execution restriction. Selection,
text hydration, and before-send expansion still reject unavailable Roles, so
broader discovery does not authorize execution or reveal private Roles.

## Decision and ownership

The [mention Spec](../../../../specs/agent-role-mentions.md) records the changed
intent as draft. Existing [pipeline documentation](../../../docs/ui-mentions.md)
owns the cross-module explanation; no earlier active Role-specific note was found.

The mention source owns context and availability. Its readable catalog comes
from `useWorkspaceAgentRoles`, preserving the shared visibility predicate.
Binding failures retain their existing reason; work-context mismatch disables
an otherwise runnable Role. The source ranks available matches before disabled matches, even if a disabled
name is a stronger fuzzy match; the registry translates the reasons. The menu passes disabled state through the existing mention primitive.
The dedicated Role category no longer cuts off at 50 rows; aggregate search
retains its cap. This favors complete discovery over limiting rendered catalog
rows, while disabled rows remain outside keyboard selection.

The separate execution selector still returns runnable Roles only. Mention
hydration and expansion check the new availability field explicitly, preventing
an unavailable catalog entry from becoming a create-session instruction.

## Verification

Targeted tests cover cross-machine plain chat, retained filesystem pinning,
precise binding reasons, available-first ordering before caps, disabled menu
rows, blocked selection, hydration and before-send behavior. Storybook includes
wide and narrow lists with available, offline, loading and out-of-context Roles.
All 108 targeted UI/shared tests passed, along with component typecheck, scoped
lint, translation-key checks and document checks. Browser screenshots verified
wide and narrow layouts. Before publishing, `pnpm check` and `pnpm format`
completed successfully; unrelated formatter-only changes were excluded. The mention primitive also now rejects disabled registered items
at its insertion entry point; previously a direct call fell back to inserting
plain mention text despite the disabled state.
