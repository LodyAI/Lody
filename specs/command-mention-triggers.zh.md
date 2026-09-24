# 命令 mention 触发符

Status: draft
Translation: current

[English](command-mention-triggers.md)

输入 `/` 或中文顿号 `、` 打开同一个命令菜单。两个前缀都支持按命令名称筛选。
选中命令后，将触发符和查询替换为标准的 `/command` token。

只有整个输入框由前缀和不含空白的查询组成时，才提供命令候选。
普通正文中的 `、` 不应提供命令。两个前缀遵循相同的命令可用性条件。
启用 Prompt Shortcuts 时，两个前缀均保留其现有的行内使用行为。
仅输入别名不会改写文本或执行命令；选择候选时复用现有 mention 插入流程。

## 证据

- [输入框](../packages/components/src/components/mentions/combined-mention-textarea.tsx)
- [菜单注册表](../packages/components/src/components/mentions/mention-registry.ts)
- [行为测试](../packages/components/tests/combined-mention-textarea-activation.test.tsx)
