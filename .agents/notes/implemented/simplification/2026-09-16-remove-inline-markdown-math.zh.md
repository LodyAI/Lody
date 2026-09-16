# 移除对话中的行内 Markdown 公式

Status: implemented
Translation: current

[English](2026-09-16-remove-inline-markdown-math.md)

## 摘要

对话 Markdown 之前会把 `$...$` 与 `\\(...\\)` 都转换为 KaTeX 行内公式。现在 Agent 回复会将这些
行内定界符保留为字面文本，同时继续支持 `$$...$$` 与 `\\[...\\]` 表示的块级公式。本次移除了自定义的
单美元 AST 转换，并将 TeX 定界符归一化限制为块级公式；取舍是行内 LaTeX 将以可读源码而非排版结果展示。

## 决策

`MarkdownRenderer` 不再安装自定义的 `remarkSingleDollarTextMath` 转换。
`normalizeTexMathDelimiters` 只归一化完整的方括号块级公式，因此圆括号行内公式会原样交给 Markdown。
Streamdown 的数学插件保持不变，用于渲染块级公式。

渲染器覆盖验证美元符号与圆括号的行内语法不会产生 KaTeX 元素，并验证方括号块级语法仍会渲染为
KaTeX 块。定界符工具的覆盖保留了余下块级归一化对代码 span 与围栏的保护。

## 验证

两个受影响的 Vitest 文件已通过（42 个用例）；`pnpm --filter @lody/components typecheck`、修改文件的
Oxfmt 检查、`pnpm run docs check` 和 `git diff --check` 也已通过。最初的 CI 失败源于测试错误地要求
Markdown 保留圆括号字面文本前后的转义反斜杠；解析器正确地移除了这些转义。
