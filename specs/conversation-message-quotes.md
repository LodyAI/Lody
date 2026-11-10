# Conversation message quotes

Status: draft
Translation: current

[中文](conversation-message-quotes.zh.md)

## Scenario and decision

A user selects part of a chat message and asks about it in a small field that
opens beside the selection (a compact dialog on mobile). Sending puts the quote
and question into the composer and sends it to an Agent; adding keeps them in the
composer draft so the user can quote again before sending. Lody owns the
quote interaction and durable snapshot; delivery uses ordinary ACP text across
Agents. An experimental implementation exists; this draft does not assert human
approval or completed runtime acceptance across Agents.

## Guarantees

The selection action and its question field stay outside conversation layout.
Opening or dismissing them does not resize the viewport or change scroll
ownership. A quote added without a question is an atomic unit at the saved
composer caret; one with a question is appended to the end of the draft followed
by that question, and sending sends the whole composer draft. Questions may sit
before, between or after quotes. Focus transfer and composer growth preserve the reading anchor under the
[existing scroll contract](conversation-scroll.md).

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

## Evidence and acceptance

The [owning research/design note](../.agents/notes/implemented/feature/2026-11-01-conversation-selection-quote-reintroduction.md)
records the withdrawn implementation, source evidence for the current Agent
catalog, snapshot format and storage decisions and browser/editor/runtime acceptance matrix.
Seven Agent paths were inspected; all-Agent runtime acceptance remains undone.
