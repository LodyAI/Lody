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

输入非空查询后，Prompt Shortcuts 与 Agent 命令按统一相关度排列。可用候选排在不可用但
完全匹配的 Prompt Shortcut 前。标准 token 或显示名称依次按完全匹配、开头匹配、
词首匹配、中间包含、非连续匹配排序；仅描述匹配排在名称匹配之后。每行仍标明来源。
只输入触发符时保留分组。来源的可见性、作用域及执行限制先于排序和选择生效。

## 证据

- [输入框](../packages/components/src/components/mentions/combined-mention-textarea.tsx)
- [菜单注册表](../packages/components/src/components/mentions/mention-registry.ts)
- [排序规则](../packages/components/src/lib/command-slash-search.ts)
- [排序评估](../packages/components/benchmarks/slash-search/eval.mjs)
- [行为测试](../packages/components/tests/combined-mention-textarea-activation.test.tsx)
