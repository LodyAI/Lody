# 侧栏右键菜单打开时隐藏行内常驻图标

Status: implemented
Translation: current

[English](2026-09-23-sidebar-menu-open-rest-fade.md)

PR: [#919](https://github.com/LodyAI/Lody/pull/919)

## 摘要

打开侧栏行的右键菜单时，行的常驻图标仍叠在显示出的操作控件上：树形连接线
穿过 `⋯` 触发器，状态或 worktree 图标透进归档按钮。reveal 层本已通过
`data-menu-open` 保持显示，但 rest 层只在 `:hover` 时隐藏——而指针在菜单
（portal 渲染）弹出的瞬间就离开了行，于是 rest 图标在仍然可见的操作控件下方
淡回。现在 fade 类名带上了与 reveal 侧相同的 `group-data-[menu-open]` 条件，
无论指针在哪都只有一层可见。已在 Storybook 中通过 DOM opacity 读取和
before/after 截图验证；从不设置 `data-menu-open` 的行不受影响。

## 原因与职责

`SessionRowLeadingSlot` 与 `SidebarRowEndSlot` 在同一段几何位置（7px 中心的
行首槽/行尾槽，见[会话树文档](../../../docs/components-sidebar-session-tree.md)）
叠画两层：rest 层（树形连接线、折叠箭头、worktree 图标、状态簇）和 reveal 层
（`⋯` 触发器、归档操作）。契约是任意时刻只画一层。reveal 侧编码了
"hover 或菜单打开"（`group-hover/row:opacity-100
group-data-[menu-open]/row:opacity-100`），rest 侧却只编码了"hover 时隐藏"
（`group-hover/row:opacity-0`）。

右键菜单通过 portal 渲染。菜单打开的瞬间，指针落在行外的菜单内容上，行的
`:hover` 消失而 `data-menu-open` 仍在。reveal 保持 opacity 1，rest 回到
opacity 1，两层在菜单打开期间一直重叠。

修复把 menu-open 变体补到 rest 侧，而不是改 reveal 侧或菜单 z-index：
`sidebar-updated-session-list.tsx` 与 `sidebar-updated-task-list.tsx` 的行首、
行尾 `fadeClassName` 增加 `group-data-[menu-open]/row:opacity-0`（rest 层可
交互处同时补 `pointer-events-none`），`sidebar-row-shared.tsx` 中
`SidebarRowEndSlot` 的默认 fade 类增加 `group-data-[menu-open]:opacity-0`，
顺带修复使用默认值的 `loro-app-sidebar.tsx` 行。备选方案——rest 层只看
menu-open——被否决：菜单还不存在时，hover 行内也必须隐藏 rest 图标；两个条件
相互独立，缺一不可。

## 证据与限制

- 在 `Updated Mode · Opened Sessions` Storybook story 的嵌套子行上复现。
  菜单打开、指针位于菜单上时，修复前树形连接线与 `⋯` 触发器的计算 opacity
  均为 1，working spinner 与归档按钮也均为 1；修复后 rest 层为 0，reveal 层
  保持 1。
- before/after 截图：`.lody/attachments/menu-open-before.png`、
  `menu-open-after.png`、`menu-open-before-after.png`。
- `pnpm --filter @lody/components typecheck` 通过；改动仅为 class 字符串。
  `session-list.tsx` 与 `task-list.tsx` 的行从不设置 `data-menu-open`，新增
  变体对其无效。
- 既有的 `@lody/components` 测试套件存在与本次无关的 jsdom 环境失败
  （`localStorage` 未定义、主题/发布 fixture）；所有侧栏行、updated 列表与
  worktree 套件均通过。
