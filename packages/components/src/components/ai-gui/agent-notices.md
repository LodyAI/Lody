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

- A tinted header line carrying the tone colour, a hairline rule, then the raw
  error — always open, never behind a modal or a disclosure. The previous
  `chat_failed` modal put the payload one click away on a surface the reader had
  no reason to expect; `chat-failed-detail-dialog.tsx` is no longer reached from
  the conversation.
- The surface mixes the tone toward the neutral border rather than fading it, so
  the card still reads as "warning" or "failure" at a glance without a vivid
  slab competing with the answer it comments on.
- Failure keeps the semantic `--destructive`. Warning uses amber, not
  `--status-warning`: that token resolves to a brown in this theme and reads as
  neither warning nor anything else at 14px.
- The hairline is a `box-shadow` ring, not `border-[0.5px]`. Chromium rounds a
  0.5px border up to a full pixel at EVERY device pixel ratio, so the utility
  renders identically to `border` and buys nothing.

## Capacity retry

- Retry targets only the latest notice: the first click consents, and bounded
  countdowns send a new continuation turn rather than replaying the failed
  input.
- A visible countdown keeps consent reversible without a second control —
  reveal stop-auto-retry on hover or keyboard focus, and show it directly on
  touch devices.
