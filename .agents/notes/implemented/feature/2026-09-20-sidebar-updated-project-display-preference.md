# Updated project identity is optional and visually muted

Status: implemented
Translation: current

[中文](2026-09-20-sidebar-updated-project-display-preference.zh.md)

## Abstract

The project line added to Updated rows improves orientation but also makes every
row taller and lets colorful GitHub avatars compete with session titles. The
sidebar view popover now exposes a persisted `Origins` switch, enabled by
default, and renders GitHub owner avatars as quiet neutral marks. The control
stays in the existing popover because this is a low-frequency view preference
rather than a primary sidebar action.

## Decision

The popover remains a conventional menu. View and Tasks are flat radio groups
with the same icon-label-check rows. `Origins` sits below both groups as a
separate switch because it is a persistent display preference rather than a
filter choice. Selecting a menu item closes the popover; changing the switch
keeps it open. The switch remains visible in Project mode so its existence and
saved state do not appear and disappear as the view changes. Project mode
disables the row and exposes an `Available in Updated view` tooltip to its
right. Hovering anywhere on the row changes only the Switch track color; the
row surface, icon, and label remain unchanged.

`sidebarUpdatedShowProjectNamesAtom` persists the global display preference in
local storage and defaults to `true`, preserving the behavior introduced by the
original [project-context decision](2026-09-20-sidebar-updated-project-context.md).
Turning it off removes the complete second line from both ordinary and Pinned
rows while Updated mode is active. Nested opened Sessions remain single-line in
either state.

Only GitHub owner avatars receive adaptive tonal normalization. After the cached
image loads, a 16px canvas sample measures alpha-weighted average luminance.
Sources at or above 65% luminance keep identity brightness and contrast; the UI
only removes color and applies 80% opacity. Opaque dark avatars progressively
reduce contrast and increase brightness toward 68% gray. Marks with substantial
transparent backgrounds use a 76% target and stronger contrast compression so
their visible black regions converge with ordinary avatars without washing out
opaque avatars. This one-sided mapping never
darkens a pale source. When the row becomes active, filter and opacity transition
for 200ms to restore the original color; hover alone does not change the mark.
Reduced-motion users switch without animation. The mark renders at 16px without a backing tile. Canvas or
CORS failure uses a neutral midpoint value. Folder and chat marks already
inherit the muted foreground token. The calculation preserves the shared avatar
source and fallback behavior without generating another image asset.

## Alternatives and trade-offs

A permanent icon beside the sidebar rows would make a low-frequency preference
compete with navigation and row actions. Nesting the preference under `Updated`
incorrectly implied navigation hierarchy and made the menu change shape.
Segmented controls made the small popover feel like a settings panel rather than
a menu. A switch at the bottom keeps the display preference visible and gives
it a control distinct from the mutually exclusive menu choices.

The label says `Origins` because the line identifies where each item belongs: a
repository, local folder, or the Chats section. The switch already communicates show/hide. The
project line still uses `Chats` as a section fallback where no repository or
folder name exists.

## Verification

The filter-popover test covers the two flat menu groups, bottom switch, checked
state, close behavior, and toggle callback. Sidebar tests cover hiding
the line from Updated and Pinned rows, while the project-context test checks the
one-sided adaptive tone and active-row treatment.
