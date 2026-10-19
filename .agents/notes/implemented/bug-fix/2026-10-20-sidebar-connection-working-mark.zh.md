# 侧栏连接加载状态沿用工作标记

Status: implemented
Translation: current

[English](2026-10-20-sidebar-connection-working-mark.md)

## 摘要

侧栏连接状态胶囊使用旋转圆环，会话行却使用侧栏统一的 3×3 工作标记，导致两种进行中的状态看起来不一致。现在 `ConnectionPill` 改用相同的 `WorkingGrid`，尺寸仍为 12px，并保留原有运行色调和无障碍标签。该方格动画已用于侧栏且支持合成器播放；本次不把它扩展到其他界面。

## 决策

- 侧栏连接胶囊的加载、重连和同步状态使用 `WorkingGrid`，与正在工作的会话标记一致。
- 保留现有 12px 尺寸、徽标色调和 `aria-label`；离线状态仍显示无图标的静态危险样式。

## 验证

- `git diff --check` 通过。
- `pnpm check`、`pnpm format` 和 `pnpm run docs check` 因嵌套 worktree 缺少
  `node_modules` 而无法完成；所需的 `tsgo`、`oxfmt` 等工具不可用。文档检查还报告了仓库已有的状态和 `AGENTS.md` 体积问题。

## Pull request

- 待创建。
