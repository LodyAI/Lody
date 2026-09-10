# Settle context compaction after provider failure

Status: implemented
Translation: current

[中文](2026-09-10-context-compaction-terminal-state.zh.md)

## Abstract

A failed remote context-compaction request could leave its tool-call item in
`pending` or `in_progress`, so both the transcript and session-usage footer kept
showing an indefinite spinner. When the provider prompt returns an ACP error or the
agent disconnects, Lody now persists unresolved compaction activities in that turn
as `failed`. Renderers continue to follow the durable tool-call status directly.

## Decision

The compaction activity and its owning assistant turn have different terminal
signals. `SessionHistory.finished` records host finalization, including interrupted
turn teardown, and therefore does not prove that the provider prompt stopped. The
UI must not infer a compaction terminal state from that field.

The prompt error path has stronger evidence: the ACP prompt returned an error, or
the provider connection ended. Before finalization clears the turn state, it asks
the finalizer to change only `pending` or `in_progress` context-compaction items in
that exact assistant turn to `failed`. Ordinary completion and cancellation do not
request this settlement. Explicit provider terminal states remain unchanged, and a
late provider update for the same `toolCallId` can still replace `failed` with
`completed`.

This fixes future error paths and histories that receive a later failure-aware
finalization. It does not migrate already persisted stale histories, because those
histories contain no durable evidence that distinguishes #570 from an interrupted
but still-active provider prompt.

## Scope and verification

This fixes [issue #570](https://github.com/LodyAI/Lody/issues/570) in
[PR #573](https://github.com/LodyAI/Lody/pull/573). It is distinct from
[issue #267](https://github.com/LodyAI/Lody/issues/267), where an interrupted manual
`/compact` may leave an actually active backend prompt. A normal cancellation
finalization intentionally leaves that compaction active instead of hiding it.

Unit coverage verifies that ordinary finalization preserves an unresolved activity
and that ACP failures request settlement. A deterministic lifecycle regression
drives the production ACP history writer and finalizer through ordinary and
failure-aware finalization, Loro document reopening, a late completed update, and a
new compaction in the next turn. No Model API Simulator or end-to-end test was added;
issue #267 still requires a separate provider cancellation fix.
