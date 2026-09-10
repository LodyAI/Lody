# Rank thinking above tool detail in the Markdown export

Status: implemented
Translation: pending

## Abstract

Copy as Markdown is how a conversation reaches another agent, machine or
workspace when native forking is unavailable, but its degradation ladder was
ordered as if the export were a transcript: thinking was dropped one level
before tool calls were touched, and the floor spent up to 120 characters per
call on bold, mid-word-truncated command strings whose results were already
gone. Prose headings inside message bodies also outranked the `## User` /
`## Assistant` headings, so long exports lost their turn structure entirely.
Thinking is now capped rather than dropped, tool calls collapse to one counted
per-turn summary before that happens, body headings are demoted, turns carry
round numbers and provenance, and the budget rose to 150k characters / 60k
tokens. The character caps and the raised budget are product judgements tuned
against synthetic fixtures, not measurements of real sessions.

## Decision

The export's purpose sets the value order. Its job is to move a conversation's
CONTEXT somewhere else, so prose-shaped content — message text, proposed plans,
and the agent's reasoning — outranks everything produced around it. The old
ladder encoded the opposite for thinking.

Four changes in `packages/shared/src/conversation-markdown.ts`:

- `LevelConfig.includeThinking: boolean` became `thinkingCap: number`. Thinking
  degrades through the same `clampMiddle` as tool results, so the head and the
  conclusion survive and the receiving conversation always inherits some of the
  reasoning. A binary drop was rejected: it is the one content class where
  losing the middle is clearly better than losing the whole.
- Tool calls collapse one level earlier than thinking is capped, and collapse to
  a single `<details>` per turn with counts by `toolName`. Simply swapping the
  two old levels was considered and is strictly worse: the old floor's per-call
  lines were themselves a large share of the budget, so aggregating first is
  what buys the room that keeps most sessions off levels 5 and 6 altogether.
- `demoteMarkdownHeadings` shifts ATX headings in message bodies down two levels
  outside fenced blocks. This is an edit to prose, which the file's own
  invariant forbids, and the invariant was narrowed rather than waived: no
  characters are removed, only `#` markers added. The alternative — abandoning
  headings as turn delimiters — loses the document outline that makes a long
  paste navigable.
- Turn headings carry a round number, local `MM-DD HH:mm`, and for assistant
  turns the recorded model and effective working time; a rule opens each new
  round; the header blockquote carries the time range, repo/branch, models, and
  the trim notice. The notice moved from footer to header because its reader is
  often another agent, which needs to know the transcript is incomplete before
  reading it. Speaker names reach turn headings only when the conversation has
  more than one distinct `userId`; repeating one name through a solo session is
  noise, and the caller supplies the `userId → name` map because `@lody/shared`
  cannot resolve it.

`describeTrim` states that collapsing drops results and terminal output rather
than incrementing the per-block tallies. A collapsed call never reaches the
block renderer, so those counters stay at zero; faking them to make the notice
accurate would have made the stats lie instead.

The budget moved from 50k/20k characters/tokens to 150k/60k. The old ceiling
predates current context windows and was the reason ordinary sessions reached
the floor at all. Secret redaction still covers terminal output and tool results
only, and deliberately not message text: a user forking a conversation wants
the material they pasted into it to travel with them.

`buildReplayPromptFromHistory` is untouched. It is the agent-facing replay
prompt, its budget behaviour is load-bearing for CLI resume, and it keeps its
own `thinkingOmitted` semantics.

## Evidence and limits

`packages/shared/tests/conversation-markdown.test.ts` covers the new behaviour
at 24 assertions, including: heading demotion leaving fenced `# comment` lines
intact and clamping at h6; collapse reached with thinking untouched; thinking
capped with `characters elided` and the block still present at the floor; round
numbering with exactly one rule per new round; model and `4m12s` working time
derived from `endedAt - timestamp - permissionWaitMs`; speaker names present
with two `userId`s and absent with one; and the trim notice preceding the first
turn. The squeezed-budget tests drive `maxChars` directly rather than building
fixtures large enough to trip the real ceiling.

`pnpm --filter @lody/shared --filter @lody/components run typecheck` passes.
Verification is fixture-based: no real session was exported and pasted into
another agent, so the claim that the new header and per-turn metadata help a
receiving model is reasoned, not measured. The 2000/500 thinking caps and the
150k/60k budget are starting values chosen against those fixtures and should be
revisited against real session data.

`.agents/docs/sessions-surface.md` holds the full rule text; the binding
one-liner stays in `packages/components/src/components/sessions/AGENTS.md`.
No Spec owns this surface today, so none was updated.
