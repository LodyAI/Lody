# CJK Markdown 强调

Status: draft
Translation: current

[English](markdown-cjk-emphasis.md)

会话 Markdown 应识别包含中文、日文或韩文标点的粗体和斜体，即使相邻正文之间
没有空格。例如，`**检查完成。**接着执行下一步。` 的第一句显示为粗体，
`前文**“重点”**后文` 的引号短语也显示为粗体。

流式回复和完成后的回复采用相同的强调规则。会话搜索和大纲文本提取遵循这些
规则，避免格式标记进入可搜索正文或使高亮偏移。转义的标记、行内代码和围栏
代码中的标记保留字面含义。普通非 CJK 强调保留现有 CommonMark 行为。

本扩展只覆盖强调，不扩展 GFM 删除线规则。

## 证据

- 实现：[Markdown 渲染器](../packages/components/src/components/ai-gui/markdown-renderer.tsx)与[搜索提取](../packages/components/src/lib/session-chat-search.ts)。
- 决策：[CJK 强调解析](../.agents/notes/implemented/bug-fix/2026-10-10-markdown-cjk-emphasis.zh.md)。
- 行为覆盖：[渲染器测试](../packages/components/tests/markdown-streaming-reparse.test.ts)与[搜索测试](../packages/components/tests/session-chat-search.test.ts)。
