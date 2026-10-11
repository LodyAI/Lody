# 会话 Markdown 对齐方式

Status: draft
Translation: current

[English](conversation-markdown-alignment.md)

会话 Markdown 段落在回复流式输出期间及完成后都使用起始边对齐。每行保持自然宽度，不会为了铺满会话列而拉伸字间距或词间距。中文、英文和混合文字均采用相同规则，因此流式回复结束时不会改变段落对齐方式。

## 证据

- 实现：[Markdown 渲染器](../packages/components/src/components/ai-gui/markdown-renderer.tsx)。
- 决策：[移除 CJK 段落两端对齐](../.agents/notes/implemented/simplification/2026-09-29-remove-cjk-markdown-justification.zh.md)。
