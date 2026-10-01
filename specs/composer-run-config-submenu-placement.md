# Composer run-config submenu placement

Status: draft
Translation: current

[中文](composer-run-config-submenu-placement.zh.md)

When a user switches between Role, Agent, Model, Interaction, Reasoning, and
provider-defined select submenus in the desktop composer, each submenu follows
the same placement rule relative to its own triggering row. The row controls
opening and selection and anchors the submenu's position.
This applies on chat landing, child-tab drafts, and existing sessions, including
menus with no Role row.

An option-only submenu aligns its top edge with the triggering row when space
permits. It does not center against the whole parent menu or clamp to the parent's bottom.

Searchable Model submenus use the same Model-row anchor while filtering. Fewer
results shrink the panel naturally; no results show only search and the empty-result
message. Never reserve unfiltered dimensions or retain a previous screen position.
The positioner recalculates against the row and current panel size, returning to
option-area alignment when space permits. Search stays at the top of the panel,
above the results or empty-result message. The panel lifts by the search field's
height and following gap so the option area, not the input, starts beside the
Model row. This offset depends on search being present, not the query or a saved
screen coordinate. Only options scroll; search remains visible, but its screen
coordinate may change as filtering resizes the popup.
Short model menus without search remain content-sized.

The submenu prefers inline-end (right in LTR, left in RTL) and may flip to the
opposite side when space requires it. Vertical collisions may shift it away from
row alignment to keep it within the viewport.
Existing viewport padding, height limits, scrolling, search focus, and selection
behavior remain in effect. This does not introduce a drill-in presentation for
windows too narrow to fit either side.
Viewport changes may still resize or reposition the search panel to keep it usable.

## Evidence

- [Desktop run-config menu](../packages/components/src/components/sessions/desktop-run-config-menu.tsx)
- [Production component stories](../packages/components/src/stories/ComposerRunConfigMenu.stories.tsx)
- [Placement decision and verification limits](../.agents/notes/implemented/bug-fix/2026-09-30-composer-cascading-submenu-placement.md)
- [Trigger-anchored model search](../.agents/notes/implemented/bug-fix/2026-09-30-model-search-trigger-anchor.md)
