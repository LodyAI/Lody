# Sidebar footer

Status: draft
Translation: current

[中文](sidebar-footer.zh.md)

When using the sidebar, users see three footer actions from left to right:
Help (`?`), Archive, Settings. Help lists documentation, GitHub, community, feedback,
and bug-report actions in that order. GitHub opens `https://github.com/LodyAI/Lody`;
feedback opens `https://github.com/LodyAI/Lody/issues` in the external browser.
Archive opens directly, without a menu. While viewing
Archive, its button returns to the previous page, or Home without history;
Help and Settings remain available. The shared desktop and mobile sidebar use
the same action order.

On desktop, the workspace control and all three actions share a 28px height
and vertical center. Action targets are square with 16px glyphs. The workspace
control is laid out like a navigation row, with a 16px avatar. The footer has 4px
vertical padding and 12px on each side, so the avatar and the Settings glyph sit
the same 18px from the edge; every adjacent pair
of controls is 4px apart, including workspace and Help. Long workspace names truncate without increasing the row height;
the syncing identity and the static local identity retain the same geometry.
The workspace control opens its menu upward. The footer has no top rule, and its
controls share the navigation rows' resting ink, hover fill and selected fill with
the header's icon buttons; Archive marks the current page while open.
Mobile retains 48px action targets with 20px glyphs and its workspace identity
in the sidebar header.

## Evidence

- Implementation: [LoroSidebar](../packages/components/src/components/loro-sidebar.tsx).
- Decision and validation limits: [footer note](../.agents/notes/implemented/feature/2026-09-26-sidebar-footer.md).
- Visual language: [footer visual-language note](../.agents/notes/implemented/feature/2026-10-17-sidebar-footer-visual-language.md).
- Control sizing: [compact footer note](../.agents/notes/implemented/feature/2026-10-04-sidebar-footer-density.md).
