# Pi shell 输出保留换行

Status: implemented
Translation: current

[English](2026-10-06-pi-shell-output-line-breaks.md)

## 摘要

Pi 执行 shell 命令后，展开步骤里的多行输出被显示成一整段。原因是 history 不认识 Pi
的结果格式，没有把它当作终端输出，结果只留下一个普通 text block，Markdown 再把单个
换行显示成空格。现在 history 会把 execute 调用的 Pi 结果存成 `terminal_output`；
步骤详情也会把 execute 调用里其他普通文本当作程序输出显示，所以旧会话也能正确显示。
修复只针对 execute 调用：Pi 其他工具的结果格式相同，但不是终端输出。

## 问题与证据

2026-10-06，所有者提供了截图：一个 Pi `bash` 步骤的输出显示成一长行，命令部分正常。
代码路径：

- `acp-extension-pi`（`toolCall`）把命令放在 `rawInput: { command }`，结果放在
  `rawOutput: { content: [{ type: 'text', text }], details }`；流式过程中的部分结果和
  最终结果也都以普通 text `content` block 发送。
- `extractTerminalOutputContent`（`packages/shared/src/acp/history-apply.ts`）只认
  Codex 的 `{ aggregated_output, exit_code }` 和 Claude/Kimi 的字符串 `rawOutput`。
  Pi 的对象两种都不匹配，所以不会生成 `terminal_output`。通用 `rawOutput` 本身不写入
  history，text block 就成了输出的唯一副本。
- 步骤详情（`view.tsx`）把既不是 JSON、也不是单个 fenced block 的文本交给
  `MarkdownRenderer`，单个 `\n` 在那里只算软换行。

## 决策

- History：`kind === 'execute'` 时，如果 `rawOutput` 是对象且 `content` 数组里有
  text block，就把这些文本拼成一个 `terminal_output`。已有的纯文本去重随后会删掉内容
  相同的 text block。去重现在还会用不 trim 的原文比较一次，这样以缩进开头的输出
  （例如 `launchctl print`）也能匹配。
- 渲染：execute 调用里的 text block，只要不是 JSON、不是单个 fenced block、也不是命令
  回显，就和 `terminal_output` 一样走有上限的尾部预览。这样修复前写入的 Pi 会话也能
  正确显示。

## 备选方案

- 在 `acp-extension-pi` 里把输出包成 fenced block：只能修好新的 Pi 会话；已有 history
  仍然显示错误，而且每个按规范用 text 返回 shell 输出的 ACP agent 都得做同样的处理。
- 把所有 `{ content: [...] }` 形式的 `rawOutput` 都当作终端输出：Pi 的 read、edit、
  search 工具也返回这种格式，它们的结果会被显示成 shell 输出，也就是
  [工具步骤详情 note](../feature/2026-09-26-tool-step-detail-sheet.zh.md) 里 `TaskStop` 的那种问题。

## 证据与限制

`packages/shared/tests/acp-history-apply.test.ts` 回放一段合成的 Pi 流（先是一个部分
结果，再是带缩进的最终结果），断言只得到一个文本完全一致的 `terminal_output`、不残留
text block，并断言 Pi `edit` 结果不会生成 `terminal_output`。
`packages/components/tests/agent-activity-row.test.tsx` 渲染一个已存储的 Pi execute
步骤，断言其文本显示在 `<pre>` 中，而不是 Markdown。

限制：

- Pi 只用文本报告失败（"Command exited with code N"），所以不会显示 `Exit N` 标记。
- 未在打包后的应用里用真实 Pi 会话验证。
