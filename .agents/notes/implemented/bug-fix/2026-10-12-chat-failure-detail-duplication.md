# Render chat failure detail once

Status: implemented
Translation: current

[中文](2026-10-12-chat-failure-detail-duplication.zh.md)

## Abstract

A single chat failure banner displayed both its readable extract and its raw
message. Removing an `Internal error:` prefix made the strings unequal, so exact
deduplication still repeated the error and any embedded advice. The banner now
renders the raw payload once and adds localized advice only when absent from that
payload and the title. Raw JSON, stack details, and the clipboard report remain
available; the trade-off is retaining provider formatting instead of a separate
readable summary.

## Decision and evidence

`ChatFailedNoticeView` assembled action, extracted summary, and raw payload with
`indexOf` equality filtering. `buildChatFailedNoticeDetail` now owns presentation
assembly in the existing pure helper module. The separate legacy dialog keeps its
extraction helper. This is distinct from the earlier
[duplicate history notice fix](2026-10-04-pre-prompt-duplicate-failure-notice.md):
no storage, dispatch, or history mutation is involved.

Normalizing away provider prefixes before comparing could fix plain messages but
would still repeat summaries embedded in JSON. Choosing one complete payload
avoids both cases without dropping diagnostic fields.

## Validation and limits

The owning helper suite covers prefixed multiline errors, embedded advice,
upstream JSON, distinct localized advice, whitespace/stack preservation, and
title-only failures. The existing notice Storybook gallery adds a synthetic
restore failure with assertions for one occurrence of each detail paragraph.
Direct Node assertions pass for the pure detail and clipboard behavior. Vitest,
Storybook, and component typechecking cannot run in this worktree because its
dependencies are absent. Documentation checking reports existing repository
errors; no changed document adds a diagnostic. The underlying routing timeout
is outside this presentation fix.
