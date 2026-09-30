# 添加可选的行内公式偏好

Status: implemented
Translation: current

[English](2026-09-28-inline-math-preference.md)

## 摘要

此前对话 Markdown 将 `$...$` 和 `\\(...\\)` 行内公式保留为源码，以避免普通美元符号被误解析。现在客户端在外观设置中提供一个选项，开启后两种写法都会使用 KaTeX 排版，默认行为保持不变。选项保存在客户端本地，并同时作用于静态和流式 Markdown。取舍是开启后用户需要接受单美元行文的既有歧义，而代码和工具负载仍由 Markdown AST 边界及专用渲染器保护。

## 决策

`inlineMathEnabledAtom` 使用 `lody-inline-math-enabled` 保存本地偏好。
`MarkdownRenderer` 在所有共享 Markdown 表面读取它。开启时，
`normalizeTexMathDelimiters` 也会转换完整的 `\\(...\\)` 配对，渲染器则加入
已有的单美元 `remarkSingleDollarTextMath` AST 处理。该处理跳过代码、链接、
已有公式节点和其他非正文节点；块级公式继续沿用原来的归一化和渲染规则。

这是对早期[移除行内公式的简化决策](../simplification/2026-09-16-remove-inline-markdown-math.zh.md)
的可选后续；那条记录仍然解释默认关闭的原因。

桌面和移动端外观设置显示同一个开关和文案。默认关闭可保持已有对话显示，
也不会改变不需要行内排版用户的工具样式文本。

## 备选方案

不考虑默认开启，因为 shell 语法以及普通货币/文本可能包含美元符号。不只支持
`\\(...\\)`，因为许多模型回复使用单美元定界符。不增加独立渲染器 prop，因为
这个选项需要一致作用于聊天、预览、技能和评论等共享表面。

## 验证与限制

聚焦测试覆盖开启后的美元和圆括号公式、默认字面行为、代码保护、定界符工具和
桌面/移动设置控件。完整包检查需要工作区依赖；当前工作树起初没有
`node_modules`。
