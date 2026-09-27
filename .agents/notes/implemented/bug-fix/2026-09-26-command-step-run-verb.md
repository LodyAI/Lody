# Command steps render with the Run/Ran verb

Status: implemented
Translation: current

[中文](2026-09-26-command-step-run-verb.zh.md)

## Abstract

Rows inside an expanded activity group read as sentences whose opening word is a
verb that follows the step's tense ("Read session-list.tsx", "Searched for
'…'"). Shell commands were the exception: agents title them with the raw
command (`sed -n '1,240p' …`), so the row rendered bare text while the group
header already said "Ran N commands". Command steps now prepend the shared
verb — "Running" while the call is in flight, "Ran" once done — through the
same tense map every other step uses.

## Problem and evidence

`ToolTitleWithHighlight` only highlights a verb the agent's own title already
opens with (`/^[A-Z][a-z]+/` in `TOOL_VERB_FORMS`). Command titles are lowercase
shell text or start with punctuation (`"sed …`), so nothing matched and the row
stayed verb-less. Reads and searches never had this problem because their
titles carry a verb or their kind label supplies one.

## Approach

- `assistant-turn-render-blocks.ts` exports `isCommandToolCall`, the same
  predicate `summarizeAssistantActivity` counts with (`execute`/`bash` kinds,
  plus any other kind that actually carried terminal I/O). The summary's
  default branch now calls it, so the counted set and the labeled set cannot
  drift apart.
- `ToolTitleWithHighlight` accepts `verb`; `ToolCallCard` passes `'Run'` for
  command steps. The verb is only prepended when the title has no leading
  capitalized word, so agent-authored labels like "Shell: cat x" keep their own
  wording and titles already opening with a known verb keep the tense swap.
- Like every other step verb it renders brightened and shimmers while the step
  runs. Verbs stay English in every locale, matching the existing verb map.
- Since the shimmering verb is itself the running signal, `ToolCallCard` drops
  the trailing spinner on any in-flight row whose title carries a tense verb
  ("Running …", "Searching …", file rows with a recognized kind label). The
  spinner stays only where a running step's own wording has no tense — authored
  labels like "Shell: …" — so no in-flight row goes signal-less.

## Limits

A command whose title opens with a capitalized non-verb word (rare; usually an
agent-authored label) still renders without a verb — that ambiguity is
unresolvable at the title layer. Verified by extending
`tests/agent-activity-row.test.tsx` to expand a live group and assert the row
text ("Ran sed -n …", "Running pnpm …", the kindless terminal-command case,
the untouched "Shell:"/"Searched for" shapes, and spinner presence only on the
verb-less running row); the affected vitest suites pass (25 tests) against a
local `pnpm install`. Visual acceptance used the new
`DesktopCommandSteps` story in `AssistantTurnAlignment.stories.tsx`.
