# DeepSeek Harness thought visibility

Status: draft
Translation: current

[中文](deepseek-thought-visibility.zh.md)

## Behavior

In a builtin DeepSeek Harness conversation, users can expand an activity group
and read the provider's emitted thoughts in order alongside tool calls. A group
containing only thoughts has a Thought disclosure rather than disappearing.
Thought-only groups default to expanded, including inside an expanded finished-work
region, while an explicit collapse remains respected. Mixed thought/tool groups
retain their existing expansion default. This applies to saved history and incoming output.

Existing activity and finished-turn folding remain available. Thoughts remain
thoughts: rendering does not convert them into normal assistant text or change
stored history. Other providers retain their current visibility behavior.
Provider identity comes from Session metadata, not the selected model name;
using a DeepSeek model through another provider does not enable this exception.

## Evidence

- [Conversation rendering](../packages/components/src/components/ai-gui/view.tsx)
- [Row behavior tests](../packages/components/tests/chat-virtual-rows-identity.test.ts)
- [Investigation](../.agents/notes/implemented/bug-fix/2026-09-27-dsh-thought-text-visibility.md)
