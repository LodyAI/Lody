# DSH thought visibility and text delivery investigation

Status: implemented
Translation: current

[中文](2026-09-27-dsh-thought-text-visibility.zh.md)

## Abstract

DSH tool activity can appear without thoughts because the conversation renderer
removes thought entries while constructing activity rows. The installed DSH
adapter successfully forwards synthetic reasoning deltas, but ordinary text is
delivered only when each native assistant message commits. These are separate
presentation and streaming behaviors; the adapter does not restrict text to the
final message of a turn. The follow-up implements readable thoughts for builtin DeepSeek Harness only;
text streaming remains a separate proposal.

## Evidence

- [Activity grouping](../../../../packages/components/src/components/ai-gui/assistant-turn-render-blocks.ts)
  places thoughts and tools in the same group. In
  [virtual row construction](../../../../packages/components/src/components/ai-gui/view.tsx),
  `appendBlockRows` filters that group to tool calls whose kind is not `think`.
  A thought-only group returns without a row; expanded mixed groups still iterate
  only those tools. The installed renderer bundle contains the same logic.
  `git blame` attributes it to `6f2051bcc` (#802), not a DSH adapter change.
- [Provider translation](../../../../packages/acp-extension-dsh/src/adapter.ts)
  forwards `agent/assistant-stream` reasoning deltas and reasoning separators.
  It ignores `text-delta` and projects text/images from durable
  `assistant/message` events instead. Final reasoning blocks are deliberately not
  replayed, to avoid duplicating already forwarded thoughts.
- The installed adapter identifies as `acp-extension-dsh` 0.2.0 and uses Harness
  0.1.5-rc.2. A temporary isolated profile loaded the installed adapter and actual
  Harness package closure, with `llm/stream` replaced by synthetic chunks. One
  reasoning delta produced an ACP thought plus its separator. Two text deltas
  produced one ACP text message. A second scenario included a nonexistent
  synthetic tool, exercising the native tool failure and next model step:
  thoughts and committed text arrived both before and after the tool lifecycle.
  No model request, real command, or captured user transcript was used in these
  fixtures.

## Ownership and limits

The follow-up restores thought rows for builtin DeepSeek Harness, selected by
Session metadata rather than model name, and updates the
[rendering rule](../../../../packages/components/src/components/ai-gui/AGENTS.md) and
[draft Spec](../../../../specs/deepseek-thought-visibility.md). The provider flag
participates in row-cache identity. Thought-only groups receive a disclosure
label; expanded groups preserve thought/tool ordering. Folding
and removing rows are different behaviors; expanding a group cannot restore rows
that were never constructed. This filter is provider-independent.

The shared filter alone does not explain why another provider appears normal.
Visible progress prose may be ordinary `text`, separate from its `thought`
entries. A provider that emits commentary before tools remains visibly
conversational while another that emits only reasoning and tools does not.
Compare native block types and persisted item types before attributing a
provider-specific symptom to this common filter. Adding text streaming improves
latency only when the model actually emits text; it cannot create missing
commentary.

Implement live ordinary text in the provider adapter separately, with explicit
handling of committed-message duplication, retries, interruptions and images.
Do not infer that a missing intermediate text means transport loss: a native
assistant message can consist solely of reasoning and tool calls.

This supplements the [tool visibility decision](2026-09-24-dsh-tool-visibility.md)
without changing its tool projection contract. The follow-up changes the shared renderer; the installed runtime is unchanged. The native UI inspection tool timed out, so the renderer
finding is established from source and the installed bundle, not a screenshot.
The isolated ACP probes validate provider delivery, not an end-to-end UI repair.

## Follow-up verification

The existing row-identity suite now covers thought-only output, visibility/cache
transitions, interrupted mixed output, and folded completed answers. Full Vitest
startup is blocked by missing `@stylexjs/unplugin`; a borrowed dependency tree
also produces missing/mismatched-package typecheck errors and was removed. An
isolated execution of the actual row builder and its actual grouping/folding
helpers passes these scenarios, with unrelated footer/subagent services stubbed.
This is narrower than a component test or visual desktop verification.

Thought-only DSH groups now default open, including under expanded finished work.
An explicit false expansion state still wins; mixed groups retain their default.
Regression coverage includes default opening, collapse/reopen and mixed groups.
