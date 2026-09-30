# 聊天输入框仍持有焦点时的模态层 Escape 归属

Status: implemented
Translation: current

[English version](2026-09-25-modal-escape-keyboard-ownership.md)

## 摘要

从聊天首页打开命令面板时，如果焦点仍留在输入框，按 Escape 可能无法关闭面板。首页的 window 捕获阶段监听器先消耗了 Escape，模态层因此收不到事件。现在键盘导航 Hook 在存在打开的模态层时会让出 Escape，即使焦点尚未移入模态层；回归测试覆盖了这一事件边界。

## 证据与决策

PR #982 的 macOS arm64 `Desktop E2E (smoke)` 在 `LODY-SHORTCUT-001` 失败：
`Meta+K` 打开命令面板后，面板输入框在五秒隐藏断言内始终可见。上传的截图和 trace 显示面板覆盖在聊天首页上。
`useChatLandingKeyboardNav` 在捕获阶段监听 `window`；当聊天输入框仍持有焦点时，其 Escape 分支会调用 `stopImmediatePropagation()` 以退出输入框焦点模式。这阻止了命令面板自身的 Escape 处理器收到事件，因此只在组件层添加处理器并不足够。

现在该 Hook 会先检查是否存在打开的模态层；若有，则让出 Escape，并由当前可见模态层负责关闭。这不会改变没有模态层时聊天首页原有的 Escape 行为。行为测试让焦点留在输入框，在其子树外挂载打开的对话框，并验证 Escape 仍能沿事件路径传播。

## 验证

- `pnpm --filter @lody/components test -- chat-landing-keyboard-nav-ime.test.tsx`
- `pnpm e2e:build && pnpm e2e:smoke`

这些检查用于验证本地事件归属回归；macOS Electron 路径仍需由 CI runner 跨平台确认。
