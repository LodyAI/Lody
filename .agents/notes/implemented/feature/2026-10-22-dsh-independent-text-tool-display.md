# Independent DSH text and tool display

Status: implemented
Translation: current

[中文](2026-10-22-dsh-independent-text-tool-display.zh.md)

## Abstract

Lody groups DSH thoughts and tools together, so a visible thought-only group can
collapse when a tool joins it. The adapter preserves text versus reasoning types;
ordinary text is delivered on each committed assistant message, not only at turn
completion. DSH prose now stays independently readable while tools default to collapsed
summaries, retaining thought semantics and explicit user toggles. The outer
finished-work fold is disabled for DSH to retain chronological order. Provider
streaming and persisted history remain unchanged.

## Evidence and ownership

- Pinned `acp-extension-dsh` commit `fed5474fa2f259df6cc94d935c8139d81aeee699`
  uses Harness `0.2.1-rc.2`. Its `src/adapter.ts` forwards reasoning deltas as
  `agent_thought_chunk`; committed text uses `agent_message_chunk`. It ignores
  live `text-delta`. Existing `src/adapter.test.ts` documents these separate paths.
- Lody's [block builder](../../../../packages/components/src/components/ai-gui/assistant-turn-render-blocks.ts)
  combines consecutive thoughts/tools. The
  [row builder](../../../../packages/components/src/components/ai-gui/view.tsx)
  defaults only pure DSH thought groups open. Completed process output can also
  disappear behind the outer worked-group disclosure.
- Upstream Web `master`, inspected 2026-10-22, separates ordinary Markdown in
  [AssistantMarkdown](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx),
  independent reasoning disclosure in
  [ReasoningRow](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-chat/src/client/chat/ReasoningRow.tsx),
  and command/input/result disclosure in
  [ToolRow](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-tool/src/client/tool/components/ToolRow.tsx).
  `use-disclosure.ts` defaults each disclosure closed. Running reasoning previews
  the latest completed paragraph's first line; settled previews depend on
  `presentation-policy.ts`. That policy also supports whole-turn process folding.
  This upstream checkout comparison does not establish identical behavior in the
  adapter's pinned release.

## Implementation and limits

Only builtin DSH, selected from Session metadata, enables the separate-thought
layout. A thought/tool boundary flushes the current activity group, preserving
keys when tools arrive. Thought groups default open and tool groups closed;
explicit toggles and search reveals retain their existing behavior. DSH skips
outer finished-work folding, keeping intermediate text visible and tools in their
original positions. Duration uses the existing footer. Both layout and row caches
include the provider policy; other providers retain their previous behavior.

This costs vertical space compared with upstream's collapsed Think preview, but
meets the requested readable intermediate prose. No stored types or provider
transport changed. Live ordinary text still waits for each committed message;
streaming it would require separate retry/interruption and deduplication work.

This revises the mixed-group presentation in the
[thought-visibility Spec](../../../../specs/deepseek-thought-visibility.md) and
supplements the [earlier investigation](../bug-fix/2026-09-27-dsh-thought-text-visibility.md).
The existing Storybook alignment suite includes a synthetic completed DSH example.

## Verification

The normal grouping suite passed 13 tests. The three owning suites passed 33 tests
with a temporary AST-based validation configuration that loads the real row-builder,
cache, comparison, grouping and helper declarations while excluding unrelated UI
renderers. This covers streaming tool arrival, independent toggles, search reveals,
completed/interrupted output, provider/cache transitions and existing plan segments.
No behavioral functions were replaced with mocks in this isolated run.

The nested worktree has no installed dependency graph. Borrowed temporary dependencies
cannot run the full UI suites (`@pierre/highlights` missing; stale UI exports), and
package typecheck fails on broader missing/mismatched dependencies. Temporary links
were removed afterward. No desktop visual validation or full build is claimed.
Documentation check has existing missing-submodule link failures; new documents
have no reported errors. Changed code passed targeted lint and diff whitespace checks.
