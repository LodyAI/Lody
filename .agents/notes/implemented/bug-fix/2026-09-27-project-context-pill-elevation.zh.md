# 恢复项目上下文标签的凸起表面

Status: implemented
Translation: current

[English](2026-09-27-project-context-pill-elevation.md)

## 摘要

新建聊天输入框上方的项目选择器在深色模式下显得平，与旁边凸起的机器和 worktree 控件不一致。
旧 Tailwind 表面样式在深色模式下关闭了阴影，只留下半透明填充。现在选择器及其 Private
分段使用共享的凸起背景、微光和阴影 token；菜单和项目选择行为保持不变。

## 决定

项目选择器通过 StyleX 使用与相邻上下文控件相同的 `@lody/ui` 凸起表面 token。
悬停和菜单打开时通过语义 hover token 改变填充。这遵循现有的
[凸起控件规则](../../../../packages/ui/src/tokens/RULES.md#edges)，不改变产品的材质契约。
选中项目的 Private 分段也使用同一表面，避免一个项目混用两种材质。
相邻的 worktree 控件已经遵循[会话控件 StyleX 决定](../simplification/2026-09-26-session-controls-stylex.zh.md)。

## 验证

Playwright 在深色模式下以 800 × 400 尺寸分别截取现有 `UnifiedProjectSelector`
Storybook 场景的修复前后画面。修复后可见原先缺失的凸起边缘和顶部微光。
Playwright 还截取了深色模式的 Private 分段和亮色模式的普通项目标签。
项目选择器的两组测试共 11 项全部通过；安装仓库声明的 ACP 子模块及本地 Electron
二进制后，`pnpm check` 和 `pnpm run docs check` 通过。这些场景验证控件表面，
不代表完整的已登录桌面新建聊天页面。
