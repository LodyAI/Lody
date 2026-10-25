# Reply excerpts in terminal notifications

Status: implemented
Translation: current

[中文](2026-10-23-notification-reply-preview.zh.md)

## Abstract

Terminal notifications previously showed project, PR and task context without the
agent's result. They now append up to 200 Unicode code points from the completed
assistant turn's last nonempty text block. Execution freezes the output entry ID
before releasing ownership, so a later turn cannot supply the excerpt. Mobile
excerpts cross the existing cloud/provider boundary; they are original reply text,
not redacted or model-generated summaries. Native display remains unverified.

## Ownership and trade-offs

This extends the [notification design](../../proposed/architecture/2026-10-13-agent-native-attention.md)'s
presentation, including its earlier names-only mobile payload decision. The
execution fact carries an optional `assistantTurnId`; it changes no eligibility,
recipient, delivery identity, cancellation or lifecycle behavior. MessageHandler
reads that exact entry after release alongside the existing bounded origin reads.
Missing or unreadable output preserves the old context. Reading the latest reply
would race with successor work; using an original input would select stale output
for an automatic summary. Neither is used.

`notificationReplyPreview` accepts forward-compatible history items and selects
only top-level assistant text, excluding thoughts, tools and child-agent output.
It collapses whitespace/control characters and truncates with an ellipsis. The
optional `presentation.replyPreview` allows 400 UTF-16 units for 200 Unicode code
points. Shared formatting appends it on a new line after existing context, or uses
it alone when context is absent. Permission/question/attention notifications ignore
the field. No extra model call, metadata payload, transcript scan or retry is added.

The latest control projection and optional cloud DTO carry the same preview.
Deploy accepting cloud consumers before the new producer; no fallback is added.
Local composition retains zero cloud requests. Reply text can itself contain paths
or code; this change does not claim content redaction. A native Effect migration
is outside this presentation change: it uses the existing backend read and delivery
owners without changing cancellation, handoff or failure recovery.

## Evidence and limits

The shared notification suite covers text selection, Unicode bounds, bilingual
formatting, request exclusion and empty fallback. CLI suites cover exact completed
entry selection with a newer reply present, missing/unreadable output, and frozen
execution identity. Native OS truncation, device delivery and clicks require device
validation; this change is not a deployment.
