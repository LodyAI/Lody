# Sidebar section scrolling

Status: draft
Translation: current

[中文](sidebar-section-scrolling.zh.md)

When a long sidebar scrolls, section labels move with their rows and leave the
viewport. Machine, GitHub Worktrees and Chats labels must not stick to the top
or overlay project or conversation rows. This also applies to other sidebar
section labels. Existing collapse controls, typography and spacing remain intact.

## Evidence

- Implementation: `packages/components/src/components/loro-app-sidebar.tsx` and
  `packages/components/src/components/session-list.tsx`.
- Manual fixture: `MachineGroupScrollingHeader` in
  `packages/components/src/stories/LoroSidebar.stories.tsx`.
- [Decision and validation limits](../.agents/notes/implemented/bug-fix/2026-09-26-sidebar-section-scrolling.md).
