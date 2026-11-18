# Thought visibility

Status: draft
Translation: current

[中文](deepseek-thought-visibility.zh.md)

## Behavior

Conversations with every provider group adjacent thoughts and tool calls in one
default-closed disclosure, preserving their order. Prose and plan approval separate groups.
Explicit toggles remain respected and search can reveal matching thoughts. New thoughts or tools
must not change the reader’s expansion choice for the existing group. During streaming, prose stays
visible. After completion, the shared finished-work disclosure collapses earlier
thoughts, tools and intermediate prose, keeping the final answer tail visible.
Users can expand the whole process again; search reveals matching folded prose.
Interrupted turns without a final answer remain expanded. These rules apply to incoming output and saved history.

Thoughts retain their label and stored type; rendering does not turn them into
ordinary assistant text or rewrite history. Visibility does not depend on the
provider, its executable or the model name.

## Evidence

- [Conversation rendering](../packages/components/src/components/ai-gui/view.tsx)
- [Row behavior tests](../packages/components/tests/chat-virtual-rows-identity.test.ts)
- [Investigation](../.agents/notes/implemented/bug-fix/2026-09-27-dsh-thought-text-visibility.md)
