# 编辑入口按会话支持情况渲染

Status: implemented
Translation: current
Issue: [#1216](https://github.com/LodyAI/Lody/issues/1216)

[English](2026-10-02-edit-affordance-unsupported-agents.md)

## 摘要

对于不支持 edit-and-resend 的 agent 会话——即 builtin Codex/Claude Code 之外的
所有 agent，例如 builtin Kimi Code——最后一条用户消息上仍然会渲染铅笔形状的
「编辑消息」按钮；保存编辑时没有任何效果：编辑框不关闭、消息不变，而且
`session/edit-and-resend` 请求从未到达 daemon。原因是对话流给最后一行用户消息
无条件传入了一个永远有值的本地包装函数，会话层的准入门槛因此根本传不到行组件。
现在只有当会话界面真正提供了编辑处理器时，流才会把它下发到行，并用一个新的渲染
测试固定了两种状态。daemon 侧的 `UNSUPPORTED_AGENT` 拒绝逻辑保持不变，仍然是
最终的强制边界。

## 证据与决策

产品门槛存在于两处必须保持一致的地方：会话界面的 `editableLastUserMessageId`
memo（`packages/components/src/components/sessions/session-chat-interface.tsx`）对
非 Codex/Claude 的 agent、已归档会话、活动中的 goal、pending-apply 消息以及
非 authoritative 的能力缓存返回 `null`；daemon 则以 `UNSUPPORTED_AGENT` 拒绝其他
agent（`apps/cli/src/session/session-edit-and-resend-service.ts`）。但
`ai-gui/index.tsx` 此前无条件地把本地 `handleEditLastUser` 包装函数传给最后一行
用户消息；包装函数里的 `if (!onEditLastUser) return false` 守卫随后把保存静默吞掉，
而行视图把 `false` 返回值当作「保持编辑框打开」处理，没有任何错误提示。在一个
builtin Kimi Code 会话上的复现显示 daemon 日志中没有任何编辑 RPC。

「在返回 false 时弹 toast」这一替代方案在本次修复中被否决：一个永远不可能成功的
入口本来就不该渲染；而且行层无法区分「会话不支持」与「准入状态瞬时变化」，后者
本来就归会话界面所有。包装函数内的守卫作为纵深防御保留。本次修复基于
[edit-and-resend 编辑器的 mention 支持](../feature/2026-09-28-edit-resend-mentions.zh.md)
所建立的编辑链路。

## 验证与限制

`packages/components/tests/user-message-edit-affordance.test.tsx` 用真实的行接线渲染
connected 对话流（仅 stub 了视口窗口化 hook）：没有会话层处理器时不渲染任何编辑
按钮；有处理器时只在最后一条用户消息上渲染一个按钮，点击后打开的编辑框预填的正是
该条消息。已在 components 测试套件上验证。未覆盖：当准入状态在「打开编辑框」与
「保存」之间发生变化时，`handleEditLastUser` 里的同一条静默 false 路径仍会无提示
失败——这一竞态留待后续处理。
