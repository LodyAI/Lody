# 让块级公式定界符保持在 Markdown 块上下文中

Status: implemented
Translation: current

[English](2026-09-29-inline-display-math-block-context.md)

## 摘要

行内公式回归问题来自一个嵌在正文后的完整 `\[...\]` 配对：渲染器仍将它改写成 `$$`，随后解析器吞入了后续内容，导致后面的行内公式没有正常排版。现在只有当块级定界符位于 Markdown 块起始位置时才会转换，也支持引用和列表块。合成渲染测试覆盖了挂载后切换设置，以及静态和流式两条路径。

## 决策

`\[...\]` 表示块级公式，只应出现在 Markdown 块起始位置。此前归一化器会转换所有完整的方括号配对，即使起始符位于普通正文之后。在这种位置，改写出的 `$$` 可能会让解析器把周围文本也当成块级公式，从而阻止后续行内公式解析。

现在归一化器接受 Markdown 引用和列表标记作为前缀；起始符若跟在正文之后则保持原样。可选的 `\(...\)` 行内解析流程不变。此选择保留块级公式语义，而不是把位置错误的块级定界符强行解释为行内公式。

## 证据

- 实现：[公式定界符归一化器](../../../../packages/components/src/lib/markdown-single-dollar-math.ts)。
- 回归覆盖：[定界符测试](../../../../packages/components/tests/markdown-math-delimiters.test.ts) 和 [渲染器测试](../../../../packages/components/tests/markdown-streaming-reparse.test.ts)。
- 契约：[Markdown 公式渲染 Spec](../../../../specs/markdown-math-rendering.zh.md)。
- 正文后出现块级定界符的合成用例，不会再阻止后续行内公式排版。
