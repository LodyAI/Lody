# 让块级公式定界符保持在 Markdown 块上下文中

Status: implemented
Translation: current

[English](2026-09-29-inline-display-math-block-context.md)

## 摘要

行内公式回归问题来自一个嵌在正文后的完整 `\[...\]` 配对：保持原样会让渲染器把它当作字面文本，因为 `remark-math` 不识别 TeX 方括号定界符。同一行的配对现在改写为同一行的 `$$...$$` 公式；跨行配对会在转换前后与正文分行，并保留引用和列表前缀，因此公式能排版且不会吞掉相邻正文。合成渲染测试覆盖静态和流式路径。

## 决策

`\[...\]` 是 TeX 的块级定界符，但真实的模型输出也会把起始符紧跟在正文后面。归一化器现在按配对形态处理：同一行的配对改写为同一行的 `$$...$$`，由 `remark-math` 按行内公式解析；跨行配对在转换后的定界符前后补换行，使公式保持块级语义而不会让 `$$` 跨越周围段落。已经位于 Markdown 块起始位置的配对保持原有块级转换；插入的行会复制引用和列表前缀。

可选的 `\(...\)` 行内解析流程不变。代码 span、围栏代码、缩进代码、链接和不完整配对仍按字面显示。

## 证据

- 实现：[公式定界符归一化器](../../../../packages/components/src/lib/markdown-single-dollar-math.ts)。
- 回归覆盖：[定界符测试](../../../../packages/components/tests/markdown-math-delimiters.test.ts) 和 [渲染器测试](../../../../packages/components/tests/markdown-streaming-reparse.test.ts)。
- 契约：[Markdown 公式渲染 Spec](../../../../specs/markdown-math-rendering.zh.md)。
- 正文后出现块级定界符的合成用例，不会再阻止后续行内公式排版。
