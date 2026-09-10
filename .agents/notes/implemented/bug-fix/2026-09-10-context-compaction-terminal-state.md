# Stop stale context-compaction indicators at the turn boundary

Status: implemented
Translation: current

[中文](2026-09-10-context-compaction-terminal-state.zh.md)

## Abstract

A failed remote context-compaction request could leave its tool-call item in
`pending` or `in_progress` even after Lody had finalized the containing assistant
turn, so both the transcript and session-usage footer kept showing an indefinite
spinner. The UI now treats the finished turn as the authoritative activity
boundary and projects any unresolved compaction inside it as stopped, while
preserving the provider's durable history item unchanged. Updated renderers recover
the display of existing affected histories as well as future failures without a
protocol simulator, but older renderers still interpret the unchanged raw status.

## Decision

The compaction activity item and its owning assistant turn have different
writers. Provider updates own the tool-call status, while Lody's turn finalizer
owns `SessionHistory.finished`. A transport failure can therefore finalize the
turn without receiving the tool call's terminal update.

Rendering now resolves one effective compaction status for both consumers. A
`pending` or `in_progress` item remains active only while its assistant turn is
unfinished; once the turn is finished, it is displayed as stopped and no longer
contributes to the session-level compacting state. `stopped` is a display-only
inference because the turn boundary does not distinguish failure, cancellation,
disconnect, or interruption. Explicit `completed` and `failed` provider states
remain unchanged.

This is a projection rule, not a history migration. Rewriting the persisted tool
call would erase the distinction between provider evidence and Lody's recovery
inference, and fixing only the future error path would leave already affected
sessions stuck. The turn boundary is available in both render paths and is the
narrowest reliable terminal signal.

## Scope and verification

This fixes [issue #570](https://github.com/LodyAI/Lody/issues/570) in
[PR #573](https://github.com/LodyAI/Lody/pull/573). It is distinct from
[issue #267](https://github.com/LodyAI/Lody/issues/267), where an interrupted manual
`/compact` may leave an actually active backend turn; this change does not alter
ACP lifecycle or cancellation behavior.

Unit coverage verifies unfinished active states, finished unresolved states, and
explicit terminal states. A deterministic lifecycle regression drives the production
ACP history writer and finalizer through an in-progress compaction, repeated
finalization, Loro document reopening, a late completed update, and a new compaction
in the next turn; it then checks the same projection used by both UI consumers. No
Model API Simulator or end-to-end test was added. Issue #267 still requires separate
runtime cancellation verification because a finished host turn does not prove that
the provider prompt has stopped.
