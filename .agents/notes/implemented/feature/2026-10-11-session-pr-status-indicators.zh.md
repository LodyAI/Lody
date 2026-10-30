# 会话 Pull Request 状态指示器

Status: implemented
Translation: current

[English](2026-10-11-session-pr-status-indicators.md)

## 摘要

侧边栏会话行与输入框上方信息栏此前缺乏直观的 PR 状态指示，PR 图标被放置在末端插槽中，且在会话处于活跃或未读状态时会被隐藏。现在顶层会话行在静止状态下直接在起始插槽展示 PR 状态图标，并在悬停时平滑渐变为操作菜单按钮，同时标题下方副标题显示带有状态色调的 `#<编号> · <状态>`。输入框上方信息栏在展台模式下呈现带状态背景色的药丸徽章，并在折叠状态的聚类图标中展示对应的状态色调。嵌套子会话与父会话保留层级树控制符，并在末端插槽回退保留 PR 标记。

## 决定

起始插槽（`SessionRowLeadingSlot`）在顶层独立会话行静止时承载 PR 状态图标（`SessionPrIcon`）。当行被悬停或键盘聚焦时，PR 图标通过 `transition-opacity` 平滑淡出，`MoreHorizontal`（`⋯`）菜单按钮在完全相同的 7px 中心淡入，保持单行对齐并杜绝布局抖动。父会话展开收起按钮与子会话树状连接符（`├` / `└`）在起始插槽中拥有更高优先级；嵌套子会话与父会话自动回退至末端插槽（`SidebarRowEndSlot`）展示 PR 图标。顶层独立会话行则在末端插槽隐藏 PR 图标，避免同单行出现重复指示器。

带有关联 Pull Request 的会话行在标题下方显示 `#<编号> · <状态>` 副标题行，使用 `PR_STATUS_META` 定义的共享状态色（`text-github-open`、`text-pr-merged`、`text-github-closed`、`text-github-draft`）。在最新更新列表模式中，`UpdatedItemProjectLine` 同样在仓库标识旁附加 PR 编号与状态文本。

在输入框上方信息栏中，`ContextChip` 将原有的低对比度浅色按钮升级为带状态色彩的药丸徽章（`bg-foreground/[0.06]` 搭配对应状态文字颜色与悬停高亮），在 480px 及以上宽度屏幕展示 `#<编号>` 与本地化状态文本。在聚类模式下，折叠芯片渲染带状态颜色的 `StatusIcon`，使用户在展台聚焦于目标或定时任务时仍可一眼辨识 PR 状态。

## 验证

- `packages/components/tests/session-list-pr-badge.test.ts`：增加用例验证顶层独立行在 `[data-session-leading-pr]` 中展示 `SessionPrIcon`、末端插槽不重复渲染、副标题显示 `#<编号> · <状态>`、已合并 PR 渲染紫色 `GitMerge` 图标与 `text-pr-merged` 样式，以及子会话保留起始树连接线与末端 PR 标记。
- `packages/components/tests/session-info-context-actions.test.tsx`：增加用例验证 `ContextChip` 在展台模式渲染带状态样式的 PR 药丸徽章，并在聚类模式下应用状态色彩。
- 执行 Vitest 测试套件：`session-list-pr-badge.test.ts` 全部 29 项测试与 `session-info-context-actions.test.tsx` 全部 7 项测试均顺利通过。
