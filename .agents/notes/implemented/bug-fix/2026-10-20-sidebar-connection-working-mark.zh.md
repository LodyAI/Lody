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

- `pnpm format` 通过。`pnpm run docs check` 通过，但报告了仓库旧笔记缺少翻译和
  `AGENTS.md` 体积等全仓警告。
- `pnpm check` 的类型检查、lint 和 Effect lint 均通过；`test:ci` 因无关的 UI
  测试五秒超时和 CLI 测试失败而未通过。针对性的 `workspace-identity.test.tsx`
  套件 9 项全通过，覆盖同步状态显示统一标记以及离线时不显示标记。
- `git diff --check` 通过。

## Pull request

- [PR #1738](https://github.com/LodyAI/Lody/pull/1738)（草稿）。
