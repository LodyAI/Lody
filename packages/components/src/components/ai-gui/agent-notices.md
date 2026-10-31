# Agent notices: warnings and chat failures

`view.tsx` renders both through one `AgentNoticeBanner`;
`build-chat-stream-items.ts` decides which row owns the notice, and
`chat-failed-error-report.ts` extracts the readable parts of a provider payload.
Binding rules live in [AGENTS.md](AGENTS.md); this file holds the invariants and
why they read the way they do. Coverage:
`tests/build-chat-stream-items.test.ts`.

## A notice belongs to the turn that emitted it

An `agent_warning` or `chat_failed` is durably its OWN system turn — the CLI
keeps it out of the assistant entry so it never reaches titles or replay
prompts. That is right for storage and wrong for reading: on its own row it
lands after the turn's footer, so the timestamp and copy button sit between the
agent's answer and the agent's own warning about it.

- So fold it back at RENDER time only. `buildConversationMarkdown` reads the
  `ConversationView`, not the stream items, so copy, share, and replay stay
  unpolluted by a presentation decision.
- The target must be the row immediately before it AND hydrated. In a windowed
  view the neighbour may be a placeholder, and a notice must never attach to a
  row whose content has not been read.
- With no assistant turn to attach to — a notice that opens a session, or one
  following a user turn — it stays exactly where it is.
- A folded notice trails the answer the way an attachment does, so it is a
  never-collapsed item in `message-copy.ts`. Left out, a turn ending in one
  reports no visible answer and folds its own reply into "Worked for …".
- Merging mutates the host item, so its cache entry is dropped: the host entry
  itself is unchanged, and a reused copy would come back without the notice.

## One banner, two tones

- A soft tone well carrying the glyph and label, then the raw error at the
  well's leading edge — always open, never behind a modal or a disclosure. The
  previous `chat_failed` modal put the payload one click away on a surface the
  reader had no reason to expect; `chat-failed-detail-dialog.tsx` is no longer
  reached from the conversation.
- Failure detail uses the full raw message once, without prepending its extracted
  summary. Prefix stripping and JSON extraction can produce a different string
  with the same information, so exact-string deduplication cannot prevent echoes.
  Localized remediation is added only when absent from the raw message and title;
  an exact title-only payload adds no detail. Copy keeps the full diagnostic report.
- The block spans the conversation column. An earlier fit-content card left a
  ragged right edge, and a header rule split one short message into two boxes.
- The well has no ring. Every other conversation surface is a fill (user bubble,
  code block, tool sheet); a tint-bordered alert was the only outlined block and
  read as chrome dropped on top of the prose. The ~4.5% tone tint still reads as
  "warning" or "failure" at a glance without a vivid slab.
- The body starts at the well's leading edge, under the glyph, rather than
  indenting under the label. Agent text is arbitrary and often long; a hanging
  indent narrowed it for no reading benefit, and the user explicitly asked for
  the full width.
- The glyph and label share one `alignItems: center` header row, so the 14px
  glyph sits on the label's optical line. Do not hand-tune a top margin on the
  glyph.
- Failure keeps the semantic `--destructive`. Warning uses amber, not
  `--status-warning`: that token resolves to a brown in this theme and reads as
  neither warning nor anything else at 14px.
- Label and detail use the subheadline role (13px at the default UI size), the
  same compact type as the activity timeline; the previous footnote size made
  the notice smaller than the conversation around it.

## Stop control diagnostics

Stop diagnostics use the existing `agent_warning` carrier because the task may still
be running. `sessionCancelFailed` identifies provider-cancel rejection,
`sessionStopTimedOut` identifies the existing five-second drain expiring before
forced termination, and `sessionTerminationFailed` identifies failed termination.
Each has a localized title and guidance followed by the original diagnostic message.
Older readers can still show the message as an ordinary warning.

The notice remains open in the conversation. It neither completes the assistant nor
claims that sending the Stop RPC stopped the provider. Repeated Stop does not add
another notice for the same turn and phase; a later turn can report the same error.
The [implementation decision](../../../../../.agents/notes/implemented/bug-fix/2026-10-29-session-stop-failure-notices.md)
records the ownership and reporting limits.

## Copying failures

Every `chat_failed` banner has an always-visible Copy error button, including
title-only failures. It copies the existing plain-text error report (title,
reason/code, session/agent/machine identifiers, remediation and full raw
message). The shared clipboard helper supplies the browser fallback; show
success only after the write succeeds, and show a failure toast otherwise.
The report starts with `Error details:`: the space prevents clipboard consumers
from interpreting the entire report as an `error:` URL and percent-encoding it.

When copy is the only trailing control, the compact button rides the
header row's trailing edge and the detail takes its own full-width line beneath
it, so copying costs no separate control row. When a capacity retry action is
present the header is already occupied, so copy keeps its footer row rather than
squeezing the title between two controls. This layout applies at every viewport
width. Long unbroken paths wrap within the detail instead of overflowing the well.

## Capacity retry

- Retry targets only the latest notice: the first click consents, and bounded
  countdowns send a new continuation turn rather than replaying the failed
  input.
- A visible countdown keeps consent reversible without a second control —
  reveal stop-auto-retry on hover or keyboard focus, and show it directly on
  touch devices.
