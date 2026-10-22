# Quote a conversation selection into the composer

Status: proposed
Translation: current

[中文](2026-10-21-conversation-selection-quote.zh.md)

## Abstract

Selecting prose inside a conversation message and asking about it means copying the
text by hand, which loses which message it came from. This proposes capturing the
native range over an immutable conversation row and staging it into the composer
draft through the existing large-pasted-text chip — the path document selections
already use — instead of adding a new `SessionInputBlock` variant. The quote is a
captured snapshot of the prose, so it cannot follow later edits to the message, and
a range that belongs to another conversation surface or exceeds the size cap is
ignored. The implementation accompanies this note and awaits review in
[#1801](https://github.com/LodyAI/Lody/pull/1801); it passes the
repository-wide check locally, while iOS/Safari long-press ordering is still
unverified.

## Problem

Asking about one paragraph of a long answer requires selecting it, copying it, and
pasting it into the composer, which drops the association with the message and the
agent's view of where the text came from. Trae and ChatGPT both offer a
select-then-annotate flow that keeps the passage attached to the question.

Nothing in the repository covers conversation text. Issue
[#1225](https://github.com/LodyAI/Lody/issues/1225) and its pull request cover *diff
line* comments, whose anchor is `path`/`lineNumber`/`side` and does not describe
conversation prose. `use-conversation-text-selection.ts` already maps a native
selection to turn ids so it can retain the rows, but it exposes no range, text or
position and drives no UI.

## Decision

Capture the range in a new surface-local hook and stage the prose as text, the way
document selections already stage a spreadsheet region or PDF page:

- `lib/conversation-selection-quote.ts` owns the snapshot shape, the size cap and the
  prompt text (`Message selection` / `Selected content:` / `> …`), mirroring
  `formatDocumentSelection`.
- `components/ai-gui/selection-quote.tsx` owns capture (`useSelectionQuote`) and the
  bar above the composer (`SelectionQuoteBar`).
- `session-chat-input-area.tsx` exposes `addSelectionQuote`, which reuses
  `insertLargePastedTextAtSelection` — the same call `addDocumentSelection` makes — so
  the quote becomes an ordinary pasted-text chip whose label is the quote itself and
  whose body expands on submit. No new input block type, no wire or storage change.
  The chip label is bracketed (`[quote…]`) because that chip paints its glyph over the
  leading `figure space + [` and leaves the trailing `] + figure space` blank — the same
  slots `[Pasted 4,182 chars]` pays for. An undelimited custom label loses the quote's
  own first and last character.

Ownership is proved by turn id: the row's `data-conversation-turn-id` must resolve in
that surface's own `ConversationView`, so a side chat beside the main conversation
cannot capture the other's selection when both are mounted.

The capture is deliberately sticky. A collapsed caret does not retire the quote, and a
`pointerdown` outside the bar does. This exists because the browser tears a native
selection down on `pointerdown` in an order the platform does not fix — an OS
long-press on a handset in particular — so a capture that followed the live range
could vanish between the press and the `click` that was meant to accept it.

## Alternatives

**A new `SessionInputBlock` variant.** `comment_reference` and
`visual_annotation_reference` already exist, so the shape is available. It was
rejected for cost: the union has more than forty touch points across
`packages/shared` and `apps/cli`, of which the compiler enforces only two
(`session-input.ts`, `message-handler.ts`). The rest fail silently — replay drops the
block, Markdown export loses it, and a strict schema downgrades a whole block list to
plain text on an older client. That is well past the 1000-line community contribution
cap, and it would put an unreviewed durable format into shared history.

**An anchor that re-resolves the message** (the shape a diff comment uses). It would
survive edits and could be rendered as a real reference chip. It needs a durable
anchor contract — what happens when the quoted turn is folded, deleted, or re-streamed —
which is a Spec-sized decision, not a trimming. Deferred; the snapshot form does not
block it later, because the chip is ordinary composer text either way.

**Extending the OS selection menu.** Not reachable from this repository: WKWebView's
custom menu needs host shell code that lives outside it.

## Scope and limits

- Entry point is one bar above the composer for every platform. Touch cannot reuse the
  long-press gesture, which belongs to the OS selection, so the bar is where a handset
  user accepts the quote; its controls keep the default button size there.
- Only prose inside an immutable history row is quotable. Local (not yet authoritative)
  rows and text outside a conversation row are ignored, as is a range past the 50,000
  character cap, which hides the action rather than truncating it silently.
- Several quotes may be staged in one draft; each becomes its own chip and the person's
  comment is ordinary composer text between them.
- The quote is a snapshot: editing the source message afterwards does not change what
  was sent, and nothing links the sent message back to the quoted turn.
- Found while implementing, and left out of this change to keep it scoped: the same
  mechanism is wrong one call site away. `addDocumentSelection` passes an undelimited
  label (`report.pdf · p.3`), so that chip paints over the file name's first character
  and hides its last. The fix is the same two brackets, and it belongs with that
  feature rather than here.

## Verification limits

- Verified in the authoring checkout: the repository-wide `pnpm check` — workspace
  type check, both linters, the whole test suite and every boundary script — passes,
  and `pnpm format` leaves this change set alone. `conversation-selection-quote.test.tsx`
  covers the format contract, ownership filtering, the sticky-capture rule,
  dismissal and handoff in jsdom; the two cases added to
  `session-chat-input-submission.test.tsx` drive the real composer, so the staged chip
  and its expansion on submit are covered rather than only the formatter.
- The interaction was exercised in a real Chromium against both Storybook stories:
  selecting prose raises the bar, and a real pointer press on its primary control —
  which tears the native range down before the `click` arrives — still stages the
  formatted quote.
- Driven end to end in the local desktop build against a real agent: a drag over an
  answer raises the bar above the composer, the primary control stages a chip labelled
  with the quote, and the reply that comes back answers the quoted passage, so the
  expansion reaches the agent. The chip's glyph slots paint over its brackets, which is
  why the staged label keeps every character of the quote.
- iOS and Safari selection ordering is not device-verified — the same gap the
  [native selection note](../../implemented/bug-fix/2026-09-20-conversation-text-selection.md)
  records.
