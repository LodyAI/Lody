# CJK Markdown emphasis

Status: draft
Translation: current

[中文](markdown-cjk-emphasis.zh.md)

Conversation Markdown recognizes bold and italic text containing Chinese, Japanese,
or Korean punctuation even when adjacent prose has no separating spaces. For
example, `**检查完成。**接着执行下一步。` renders the first sentence in bold, and
`前文**“重点”**后文` renders the quoted phrase in bold.

Streaming and completed replies use the same emphasis rules. Session search and
outline text extraction follow those rules so formatting markers do not appear in
searchable prose or shift highlight offsets. Escaped markers and markers inside
inline or fenced code remain literal. Ordinary non-CJK emphasis keeps its existing
CommonMark behavior.

This extension covers emphasis; it does not extend GFM strikethrough rules.

## Evidence

- Implementation: [Markdown renderer](../packages/components/src/components/ai-gui/markdown-renderer.tsx) and [search extraction](../packages/components/src/lib/session-chat-search.ts).
- Decision: [CJK emphasis parsing](../.agents/notes/implemented/bug-fix/2026-10-10-markdown-cjk-emphasis.md).
- Behavioral coverage: [renderer suite](../packages/components/tests/markdown-streaming-reparse.test.ts) and [search suite](../packages/components/tests/session-chat-search.test.ts).
