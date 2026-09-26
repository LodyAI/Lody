# 命令步骤渲染 Run/Ran 动词

Status: implemented
Translation: current

[English](2026-09-26-command-step-run-verb.md)

## 摘要

展开的活动分组里，每一行都是一个以动词开头的句子，动词随步骤时态变化
（"Read session-list.tsx"、"Searched for '…'"）。唯独 shell 命令例外：
agent 把原始命令作为标题（`sed -n '1,240p' …`），行内只剩裸文本，而分组
标题却已经在说 "Ran N commands"。现在命令步骤会补上同一个动词——进行中
显示 "Running"，完成后显示 "Ran"——走的是和其它步骤相同的时态映射。

## 问题与证据

`ToolTitleWithHighlight` 只在 agent 标题本身以动词开头时才做高亮
（`/^[A-Z][a-z]+/` 命中 `TOOL_VERB_FORMS`）。命令标题是小写的 shell 文本
或以标点开头（`"sed …`），永远匹配不到，行就一直缺动词。读取和搜索类
步骤没有这个问题，因为它们的标题自带动词，或由 kind 标签提供。

## 方案

- `assistant-turn-render-blocks.ts` 导出 `isCommandToolCall`——与
  `summarizeAssistantActivity` 计数所用判定相同（`execute`/`bash` kind，
  以及其它确实携带终端 I/O 的 kind）。summary 的 default 分支改为调用它，
  保证"计入命令数的集合"和"加动词前缀的集合"不会再分叉。
- `ToolTitleWithHighlight` 新增 `verb`；`ToolCallCard` 对命令步骤传
  `'Run'`。仅当标题没有以大写单词开头时才前置动词，因此 agent 自己写的
  标签（如 "Shell: cat x"）保持原文，已带已知动词的标题仍走原时态替换。
- 与其它步骤动词一致：加粗高亮，运行中 shimmer。动词在各语言下都保持
  英文，与现有动词映射一致。
- 既然 shimmer 动词本身就是运行态信号，`ToolCallCard` 在所有标题带时态
  动词的进行中行（"Running …"、"Searching …"、带已知 kind 标签的文件行）
  上移除行尾 spinner。spinner 只保留在措辞不带时态的运行中行（如
  "Shell: …" 这类 agent 自写标签）——不让任何运行中行失去信号。

## 限制

标题以大写非动词单词开头的命令（少见，多为 agent 自写标签）仍不加动词
——标题层无法消歧。验证方式：扩展 `tests/agent-activity-row.test.tsx`，
展开一个进行中的分组并断言行文本（"Ran sed -n …"、"Running pnpm …"、
无 kind 的 terminal_command 情形、保持不变的 "Shell:"/"Searched for" 形态，
以及 spinner 只出现在无动词的运行中行上）；受影响的 vitest 套件在本仓
`pnpm install` 后全部通过（25 个测试）。视觉验收使用新增的
`AssistantTurnAlignment.stories.tsx` 的 `DesktopCommandSteps` story。
