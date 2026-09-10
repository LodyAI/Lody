# Settle context compaction after provider failure

Status: implemented
Translation: current

[中文](2026-09-10-context-compaction-terminal-state.zh.md)

## Abstract

A failed or cancelled remote context-compaction request could leave its tool-call
item in `pending` or `in_progress`, so both the transcript and session-usage footer
kept showing an indefinite spinner after the provider was no longer active. Lody
now persists unresolved compaction activities in that turn as `failed` after a
failed provider prompt settles or the cancelled prompt is successfully terminated.
Renderers continue to follow the durable tool-call status directly.

## Decision

The compaction activity and its owning assistant turn have different terminal
signals. `SessionHistory.finished` records host finalization, including interrupted
turn teardown, and therefore does not prove that the provider prompt stopped. The
UI must not infer a compaction terminal state from that field.

The prompt error path has stronger evidence: a prompt that started has returned
control with an error and is no longer in flight. Before finalization clears the
turn state, it asks the finalizer to change only `pending` or `in_progress`
context-compaction items in that exact assistant turn to `failed`. This lifecycle
signal covers transport failures such as `Connection failed: error sending request`
without depending on a numeric ACP error code or a message allowlist.

Cancellation has two phases. Host teardown first records the cancelled turn while
leaving compaction active. The execution owner then waits for the raw ACP request;
after five seconds it may terminate the old session, and a failed termination keeps
waiting for raw completion. Only after that drain completes does the host settle
the unresolved compaction, flush the usage state, and release the owner. Explicit
provider terminal states remain unchanged, and a late provider update for the same
`toolCallId` can still replace `failed` with `completed`.

This fixes future error paths and histories that receive a later failure-aware
finalization. It does not migrate already persisted stale histories, because those
histories contain no durable evidence that distinguishes #570 from an interrupted
but still-active provider prompt.

## Scope and verification

This fixes [issue #570](https://github.com/LodyAI/Lody/issues/570) in
[PR #573](https://github.com/LodyAI/Lody/pull/573). Together with the provider
ownership recovery from [PR #571](https://github.com/LodyAI/Lody/pull/571), it also
completes the compaction activity cleanup required by
[issue #267](https://github.com/LodyAI/Lody/issues/267): an interrupted `/compact`
remains active while the provider prompt is active, then becomes terminal before
the next prompt can acquire the session.

Unit coverage uses the exact #570 transport-error shape and verifies that a settled
provider prompt requests compaction settlement without an ACP code. Deterministic
cancellation coverage verifies that compaction remains active while raw provider
ownership is retained, becomes failed after raw completion or successful
termination, stays active after failed termination, and is settled before the next
prompt runs. The lifecycle regression also covers Loro document reopening, a late
completed update, and a new compaction in the next turn. No Model API Simulator or
end-to-end test was added.
