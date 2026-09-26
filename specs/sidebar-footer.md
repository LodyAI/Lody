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

## Evidence

- Implementation: [LoroSidebar](../packages/components/src/components/loro-sidebar.tsx).
- Decision and validation limits: [footer note](../.agents/notes/implemented/feature/2026-09-26-sidebar-footer.md).
