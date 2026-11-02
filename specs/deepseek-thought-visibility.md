# DeepSeek Harness thought visibility

Status: draft
Translation: current

[中文](deepseek-thought-visibility.zh.md)

## Behavior

Builtin DeepSeek Harness conversations show thoughts in independent default-open
disclosures and tools in separate default-closed groups, preserving their order.
Explicit toggles remain respected and search can reveal matching thoughts. Tool
arrival must not collapse preceding thoughts. During streaming, prose stays
visible. After completion, the shared finished-work disclosure collapses earlier
thoughts, tools and intermediate prose, keeping the final answer tail visible.
Users can expand the whole process again; search reveals matching folded prose.
Interrupted turns without a final answer remain expanded. These rules apply to incoming output and saved history.

Thoughts retain their label and stored type; rendering does not turn them into
ordinary assistant text or rewrite history. Provider identity comes from Session
metadata, not the model name. Other providers retain their existing visibility
and folding, including when using a DeepSeek model.

## Evidence

- [Conversation rendering](../packages/components/src/components/ai-gui/view.tsx)
- [Row behavior tests](../packages/components/tests/chat-virtual-rows-identity.test.ts)
- [Investigation](../.agents/notes/implemented/bug-fix/2026-09-27-dsh-thought-text-visibility.md)
