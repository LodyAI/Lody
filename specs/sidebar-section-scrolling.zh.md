# 侧栏分组标题滚动

Status: draft
Translation: current

[English](sidebar-section-scrolling.md)

长侧栏滚动时，分组标题随所属行一起移动并离开视口。机器、GitHub Worktrees 和
Chats 标签不得吸顶或覆盖项目、会话行，其他侧栏分组标题也遵循此规则。
保留现有折叠控件、字号和间距。

## 依据

- 实现：`packages/components/src/components/loro-app-sidebar.tsx` 与
  `packages/components/src/components/session-list.tsx`。
- 手动场景：`packages/components/src/stories/LoroSidebar.stories.tsx` 中的
  `MachineGroupScrollingHeader`。
- [决策与验证限制](../.agents/notes/implemented/bug-fix/2026-09-26-sidebar-section-scrolling.zh.md)。
