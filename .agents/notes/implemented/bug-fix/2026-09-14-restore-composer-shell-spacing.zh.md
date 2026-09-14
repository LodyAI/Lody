# 恢复 Composer 外层底部间距

Status: implemented
Translation: current

[English](2026-09-14-restore-composer-shell-spacing.md)

## 摘要

PR #655 为了让底部空白区域可以聚焦输入框，把 desktop session composer 的 8px 底部间距从共享 shell 移到了可点击的 composer card 内；随后追加的 class merge 又使会话 shell 原本的 `pb` 消失，导致 landing 和具体会话的间距归属不一致。本次将间距恢复到共享 shell，同时让 shell 空白区域直接聚焦输入框，保留原有的编辑聚焦行为。

## 决策

- landing 与具体会话统一保留共享 shell 的 `pb-[calc(...)]`。
- session card 恢复原来的 `py-1.5`，不在 card 内重复增加 desktop 底部间距。
- 只有鼠标左键点击 shell 自身空白区域时才会先阻止浏览器默认的 mousedown 焦点处理，再聚焦输入框，不影响 selector、附件和输入框本身的交互。

## 证据

- 回归来自 `b5746d02` / PR #655：它同时加入了 card 的 `pb-3.5` 和 desktop-only 的 shell `pb-[max(...)]`；`tailwind-merge` 因此丢弃了共享 shell 的 padding。
- 现有 composer focus 浏览器旅程覆盖了点击 shell 底部区域后继续输入的行为。

## 验证

- `git diff --check` 已通过。
- 现有 `composer-submission-focus` 浏览器旅程覆盖了恢复后的 shell 底部区域点击与继续输入行为。
- 已尝试运行 pnpm 检查，但当前 worktree 中连 `pnpm --version` 都一直无响应，因此 typecheck、Vitest、Prettier 和 `pnpm run docs check` 尚未执行。
