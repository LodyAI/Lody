# Skill mention 触发符

Status: draft
Translation: current

[English](skill-mention-triggers.md)

输入 `$` 或中文全角人民币符号 `￥` 会打开同一个 Skills 菜单，也支持在提示词中间触发。
两个前缀使用相同的查询过滤、来源可用性条件和 Provider 目录限制。

选中 Skill 后，以规范的 `$skill-name` mention 替换触发符和查询词。
其保存的范围、恢复和发送前展开沿用现有 Skill 路径。
关闭菜单保留输入的原文；未选中的 `￥skill-name` 是普通文本，不是 Skill 引用。

## 证据

- [输入框与选择行为测试](../packages/components/tests/combined-mention-textarea-activation.test.tsx)
- [菜单路由](../packages/components/src/components/mentions/mention-registry.ts)
