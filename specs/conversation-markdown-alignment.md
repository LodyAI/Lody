# Conversation Markdown alignment

Status: draft
Translation: current

[中文](conversation-markdown-alignment.zh.md)

Conversation Markdown paragraphs use start alignment while a reply is streaming
and after it is complete. Lines keep their natural widths instead of expanding
character or word spacing to fill the conversation column. This applies equally
to Chinese, English, and mixed-script prose, so finishing a streamed reply does
not change its paragraph alignment.

## Evidence

- Implementation: [Markdown renderer](../packages/components/src/components/ai-gui/markdown-renderer.tsx) and [conversation Markdown styles](../packages/components/src/tailwind/index.css).
- Decision: [remove CJK paragraph justification](../.agents/notes/implemented/simplification/2026-09-29-remove-cjk-markdown-justification.md).
