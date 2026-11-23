# 防止比较运算符截断流式数学文档

Status: implemented
Translation: current

[English](2026-09-20-streamdown-math-document-truncation.md)

## 摘要

包含 `p<q` 这类块级 LaTeX 的 Markdown 回答，可能在对话视图中丢失公式之后的
全部章节。Streamdown 的 Remend 补全器把比较符误认为未完成的 HTML 标签，并删除
了后续流式文本。现在渲染器只关闭这一步 HTML 标签补全；Markdown 解析、块级数学
公式渲染和已有的安全 HTML 链路保持不变。回归测试覆盖了公式中的比较符、后续公式
以及末尾章节。

## 决策

`MarkdownRenderer` 向 Streamdown 传入 `remend={{ htmlTags: false }}`。这个界面不需要
HTML 标签补全：原始 HTML 仍由已有的 `allowHtml` 属性显式开启，并继续经过
`rehypeRaw` 与 `rehypeSanitize`。关闭补全可以避免把 TeX 比较运算符当成 HTML，同时
保留其它流式补全行为。

回归测试渲染合成 Markdown，其中包含 `p<q`、一个 aligned 块级公式和末尾参考章节，
断言末尾文本仍然存在，并且两个块级公式都成功渲染。

## 验证

定向 Markdown、数学分隔符和 idle-rerender 测试通过，共 45 项。components 包的类型
检查、Oxfmt 检查和 Oxlint 检查通过。合并前仍需运行完整仓库检查。
