# 让 CJK Markdown 正文两端对齐

Status: implemented
Translation: current

[English](2026-09-28-cjk-markdown-justification.md)

## 摘要

会话 Markdown 中的中文段落右边缘参差不齐，但对所有消息强制两端对齐会拉大英文和技术内容的词间距。现在渲染器会识别每个包含汉字的段落，只对顶层正文块启用两端对齐。标题、列表、表格、引用、行内代码和围栏代码继续保持起始对齐。末行仍从起始边对齐，因此改善了段落边缘，同时不会产生很大的尾部空隙。

## 决策

- `MarkdownRenderer` 提取每个渲染段落的文本，包含汉字时添加 `markdown-cjk-paragraph` 类。
- `tailwind/index.css` 只对标记过的顶层段落使用 `text-align: justify`、`text-justify: auto` 和 `text-align-last: start`。
- 判断依据是内容而不是界面语言：英文界面也可能收到中文回复，中文界面也可能收到英文回复。

## 替代方案

- 否决对所有 Markdown 段落两端对齐，因为英文、包名、URL 和数字可能产生过大的词间距。
- 否决对整个渲染器设置 `text-align: justify`，因为它也会影响标题、列表、表格和代码区域。
- 否决只依据 `lang="zh"`，因为消息内容可以是中文而应用界面仍使用英文。

## 验证与限制

- 选择器限定为标记过的顶层段落，因此标题、列表、引用、表格和代码区域不变。
- 只要段落中发现一个汉字就视为 CJK 内容；少量中文片段和英文混合的段落也可能因此两端对齐。
- 当前 checkout 没有 `pnpm`/Corepack 和工作区依赖，因此未运行包级检查。
