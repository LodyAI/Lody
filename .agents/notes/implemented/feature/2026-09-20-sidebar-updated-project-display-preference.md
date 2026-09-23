# Updated project identity is optional and visually muted

Status: implemented
Translation: current

[中文](2026-09-20-sidebar-updated-project-display-preference.zh.md)

## Abstract

The project line added to Updated rows improves orientation but also makes every
row taller and lets colorful GitHub avatars compete with session titles. The
sidebar view popover now exposes a persisted `Show Project` switch, enabled by
default, and renders GitHub owner avatars in their original colors at 60%
opacity. The control stays in the existing popover because this is a
low-frequency view preference rather than a primary sidebar action.

## Decision

The popover remains a conventional menu. View and Tasks are flat radio groups
with the same icon-label-check rows. `Show Project` sits below both groups as a
separate switch because it is a persistent display preference rather than a
filter choice. Selecting a menu item closes the popover; changing the switch
keeps it open. The switch remains visible in Project mode so its existence and
saved state do not appear and disappear as the view changes. Project mode
disables the row and exposes an `Available in Updated view` tooltip to its
right. Hovering anywhere on the row changes only the Switch track color; the
row surface, icon, and label remain unchanged. Touching the disabled row opens
the same hint, and the focusable row preserves keyboard access.

`sidebarUpdatedShowProjectNamesAtom` persists the global display preference in
local storage and defaults to `true`, preserving the behavior introduced by the
original [project-context decision](2026-09-20-sidebar-updated-project-context.md).
Turning it off removes the complete second line from both ordinary and Pinned
rows while Updated mode is active. Nested opened Sessions remain single-line in
either state.

GitHub owner avatars render at 16px without a backing tile. They keep the source
colors and use a fixed 60% opacity; hover and active selection do not change
their appearance. This avoids per-image filters and keeps every source subject
to the same visual-weight rule. The shared avatar component still falls back to
the GitHub glyph on an invalid owner or image-load failure. Folder and chat marks
continue to inherit the muted foreground token.

## Alternatives and trade-offs

A permanent icon beside the sidebar rows would make a low-frequency preference
compete with navigation and row actions. Nesting the preference under `Updated`
incorrectly implied navigation hierarchy and made the menu change shape.
Segmented controls made the small popover feel like a settings panel rather than
a menu. A switch at the bottom keeps the display preference visible and gives
it a control distinct from the mutually exclusive menu choices.

The label says `Show Project` to state the action directly. The project line can
identify a repository, local folder, or the Chats section and still uses `Chats`
as a fallback where no repository or folder name exists.

## Verification

The filter-popover test covers the two flat menu groups, bottom switch, checked
state, close behavior, and toggle callback. Sidebar tests cover hiding
the line from Updated and Pinned rows, while the project-context test checks the
fixed owner-avatar opacity for ordinary and active rows. The `Updated Mode ·
Show Project Overview` Storybook story combines Pinned, Chats, local and
multiple GitHub sources with an active row inside the production-mirroring
session page harness, where the menu remains interactive for visual review. Its
All Tasks fixture gives every row kind an author, matching production's
multi-member scope instead of creating an impossible mix of authored and
unauthored rows.
