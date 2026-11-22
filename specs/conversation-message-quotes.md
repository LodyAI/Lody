# Conversation message quotes

Status: draft
Translation: current

[中文](conversation-message-quotes.zh.md)

## Scenario and decision

A user selects part of a chat message and clicks Quote to insert a snapshot
at the composer's last used caret. Focus returns to the composer, where the user
can type a question or add more quotes before sending. Lody owns the quote
interaction and durable snapshot; delivery uses ordinary ACP text across Agents.
An experimental implementation exists; this draft does not assert human
approval or completed runtime acceptance across Agents.

## Guarantees

The selection action stays outside conversation layout. Appearing or dismissing
it does not resize the viewport or change scroll ownership. Clicking it directly
inserts an atomic quote at the saved composer caret, appending if none exists.
Questions may sit before, between or after quotes. The composer grows with the
inserted content up to its row limit, then scrolls internally to keep the caret
visible. Focus transfer and composer growth preserve the reading anchor under
the [existing scroll contract](conversation-scroll.md).

The quote is a read-only snapshot of the selected text at capture time. Preview
shows that snapshot; later source changes do not alter it. Removal and editor
undo/redo treat it as a unit. Source-message navigation is outside this initial
guarantee. Switching Agent preserves the draft and interaction.

Accepted authored history retains full text and validated quote display metadata.
Lody draft restoration and supported edit/resend restore quote units. This does
not change inline spacing; persisted drafts retain committed mention identities. It does
not expand which Agents support editing. Rejected submission retains the draft;
acceptance clears only submitted state. Provider-native imports without Lody
metadata remain readable text rather than guessed quote units.

One shared, versioned projection includes full snapshots and adjacent question
prose in order before the Agent boundary. Prompt, supported queue/steer, retry and
fallback replay use that text; existing replay budgets remain applicable. No
Agent-specific annotation format or answer directive is required. Text delivery
does not guarantee a model's interpretation of a quote.

New structured quote input requires the target machine's advertised versioned
protocol capability. Missing support preserves drafts and explicitly explains
unavailability; it never silently downgrades the promised interaction. Existing
history compatibility and writer ownership continue to apply.

## Native mobile

Native iOS and Android clients keep the same snapshot, projection, capability and
history guarantees but use a touch-first composer form. Long-press selection in
one Agent message offers Quote (user messages are not quotable) in the system text menu; it opens a bottom sheet with the
read-only snapshot and an optional comment. Each quote and its comment become one
card in the composer attachment strip, which reopens the sheet for editing the
comment or removing the card. Inline caret insertion does not apply there.

Sending places the composer text first, then each card's quote block followed by
its comment, in the same versioned text and quote spans Web sends, so either client
renders and restores the other's messages. Native restoration reads text before the
first quote as composer text and the text after each quote as that card's comment.
Native history renders authored quotes as blocks that open the full snapshot.

## Evidence and acceptance

The [owning research/design note](../.agents/notes/implemented/feature/2026-11-01-conversation-selection-quote-reintroduction.md)
records the withdrawn implementation, source evidence for the current Agent
catalog, snapshot format and storage decisions and browser/editor/runtime acceptance matrix.
Seven Agent paths were inspected; all-Agent runtime acceptance remains undone.
