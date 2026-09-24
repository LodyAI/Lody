# Agent notice banner spans the column and drops its header rule

Status: implemented
Translation: current

[中文](2026-09-23-agent-notice-banner-full-width.zh.md)

## Abstract

`AgentNoticeBanner` — the one surface `chat_failed` and `agent_warning` share —
was a fit-content card whose header and detail were split by a hairline rule.
In place it read as a ragged-edged fragment beside the conversation's otherwise
straight right rail, and the rule split a two-line message into two boxes. The
banner now spans the full column width and renders header and detail as one
continuous band. The trade-off is the one the original design accepted on
purpose: a full-width notice carries the same visual weight as the answer it
comments on. That cost was reconsidered and found smaller than the fragmented
look it bought.

## Decision

Commit `3775a23c` introduced the shared banner as `w-fit max-w-full` with an
`inset 0 0.5px` shadow rule between header and body, arguing a notice is a
subordinate aside that should not compete with the answer, and that a width cap
kept long payloads to a readable measure. In practice the card sits in a fixed
conversation column already narrower than the prose measure, so the cap almost
never engaged; what readers saw was a short label in a card that stopped
mid-column, followed by a second hairline dividing two lines of the same
message.

`view.tsx` now renders the banner `w-full` with no internal rule; the detail
keeps its horizontal padding and loses its top padding so the band reads
continuously, and an action (the capacity retry button) rides the header's
trailing edge instead of forming a third row. The tone ring, mixed fill, and
glyph/label colour coding are unchanged. The fenced-code-block resemblance
survives in the ringed, rounded block rather than the internal three-part
split.

## Alternatives considered

- Keep `w-fit` and only remove the rule: fixes the two-box split but leaves the
  ragged right edge that prompted the report.
- Keep the rule only when an action follows (capacity retry): a conditional
  divider reintroduces per-variant geometry for no reading benefit; the action
  sits on the header's trailing edge instead.

## Verification

`Sessions/ConversationView → ConversationWithNotices` in Storybook shows both
tones in place among real rows: before, each card stopped short of the column
with a visible rule under its header; after, both span the column as single
bands. Checked in a light theme at desktop width; dark-theme tone mixing was
not re-reviewed, though no colour token changed.
