# DeepSeek Harness 思考可见性

Status: draft
Translation: current

[English](deepseek-thought-visibility.md)

## 行为

在内置 DeepSeek Harness 对话中，用户可以展开活动分组，按原有顺序阅读 provider
输出的思考与工具调用。只有思考的分组也应显示“思考”展开入口，而不是消失。
纯思考分组默认展开，包括展开外层已完成活动记录后的纯思考分组；用户明确收起后
保留其选择。思考与工具混合分组维持原有默认状态。此行为适用于已有历史和新收到的输出。

保留现有活动分组及完成回合的折叠机制。思考仍属于思考：渲染不把它转换为普通
助手文本，也不修改存储的历史。其他 provider 保留当前的可见性行为。
Provider 身份来自 Session 元数据，不根据模型名称判断；通过其他 provider 使用
DeepSeek 模型不会启用该例外。

## 证据

- [对话渲染](../packages/components/src/components/ai-gui/view.tsx)
- [行行为测试](../packages/components/tests/chat-virtual-rows-identity.test.ts)
- [调查记录](../.agents/notes/implemented/bug-fix/2026-09-27-dsh-thought-text-visibility.zh.md)
