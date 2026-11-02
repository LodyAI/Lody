# 会话 Pull Request 状态指示器

Status: implemented
Translation: current

[English](2026-10-11-session-pr-status-indicators.md)

## 摘要

侧边栏会话行与输入框上方信息栏此前缺乏直观的 PR 状态展示，PR 状态细节多依赖悬停卡片或藏于会话详情中。现在双行会话行在标题下方的第二行元数据中，与分支名及相对时间并列展示 PR 状态（`#<编号> · <状态>`），末端插槽在静止时继续展示带 CI 裁切的紧凑 PR 图标。输入框上方信息栏在展台模式下呈现带状态背景色的药丸徽章，并在折叠状态的聚类芯片中展示对应的状态色彩。起始插槽则完整保持平铺对齐与树状层级控制符。

## 决定

侧边栏会话行将 PR 状态置于标题下方的第二行元数据（`SidebarSessionMetaLine`）中：`{[分支图标] scope/branch-name} {10m} {PR 状态}`。PR 片段（`SidebarPrSegment`）使用 `PR_STATUS_META` 定义的共享状态色（`text-github-open`、`text-pr-merged`、`text-github-closed`、`text-github-draft`）渲染 `#<编号> · <状态>`。在最新更新模式中，`UpdatedItemProjectLine` 同样在项目标识旁附加该 PR 片段。

起始插槽（`SessionRowLeadingSlot`）严格保持现有的身份标识与树状层级：父会话展开折叠符、子会话树状连接线（`├` / `└`），以及顶层独立会话行在静止状态下的 14px 空插槽（悬停时淡入 `MoreHorizontal` `⋯` 菜单）。末端插槽（`SidebarRowEndSlot`）在静止时继续承载带 CI 裁切遮罩的紧凑 `SessionPrIcon`，并在会话进行、等待或未读时按优先级让位。

在输入框上方信息栏中，`ContextChip` 将原有的低对比度浅色按钮升级为带状态色彩的药丸徽章（`bg-foreground/[0.06]` 搭配对应状态文字颜色与悬停高亮），在 480px 及以上宽度屏幕展示 `#<编号>` 与本地化状态文本。在聚类模式下，折叠芯片渲染带状态颜色的 `StatusIcon`，使用户在展台聚焦于目标或定时任务时仍可一眼辨识 PR 状态。

## 验证

- `packages/components/tests/session-list-pr-badge.test.ts`：验证 `SidebarSessionMetaLine` 正确组合分支名、时间戳与带状态色的 PR 片段；确认独立行与层级行在起始插槽保持原有树状结构；验证末端插槽在静止时展示带 CI 遮罩的 `SessionPrIcon`；并断言已合并 PR 渲染紫色 `GitMerge` 图标与 `text-pr-merged` 样式。
- `packages/components/tests/session-info-context-actions.test.tsx`：验证 `ContextChip` 在展台模式渲染带状态样式的 PR 药丸徽章，并在聚类模式下应用状态色彩。
