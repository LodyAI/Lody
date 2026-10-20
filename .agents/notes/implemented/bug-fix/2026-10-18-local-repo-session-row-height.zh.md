# 直接运行的本地项目会话保持单行

Status: implemented
Translation: current

[English](2026-10-18-local-repo-session-row-height.md)

## 摘要

桌面本地项目行之前会给所有顶层会话显示分支和时间，即使会话直接运行在项目目录中、只是带有 GitHub 仓库元数据。这会让关联仓库的直接会话看起来像 worktree 会话，并多占一行。现在只有本地 worktree 会话会在标题下显示分支和时间；直接会话保留仓库和 PR 操作，同时保持单行。首个子会话的树形连接只会在 opener 实际带有 worktree 元数据行时延伸到第二行。

## 发现与决策

`LocalProjectSessionItem` 之前用 `isWorktree` 控制 worktree 图标，但两行布局条件只检查会话是否为嵌套子项。`session.project.githubRepoFullName` 可以给直接本地会话关联 GitHub 仓库，却不会因此创建 worktree，所以仓库元数据不能作为显示分支和时间行的依据。

本地项目元数据行改为仅在 `session.isWorktree === true` 时显示。仓库和 PR 详情继续通过现有行内操作和悬浮卡片提供。如果 opener 没有元数据行，首个子会话连接线采用单行几何；worktree opener 保持原有的加长连接。完整工作区 Story 新增一个合成的“有关联仓库但直接运行”的会话，可与普通本地会话和 worktree 会话切换对比。

## 验证

使用 Oxfmt、`git diff --check`、组件包类型检查和 Storybook 浏览器渲染检查新增的仓库关联 Story 状态。组件类型检查报告了本次改动范围之外的两项既有错误，分别位于 `loro-sidebar.tsx` 和 `home-week-usage.ts`；Story 页面渲染没有浏览器 page error。未新增或运行自动化测试。

相关说明：[侧栏会话树](../../../docs/components-sidebar-session-tree.md)。
