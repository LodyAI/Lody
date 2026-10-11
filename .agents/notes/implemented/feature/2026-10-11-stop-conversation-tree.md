# Stop a conversation tree without automatic reawakening

Status: implemented
Translation: current

[中文](2026-10-11-stop-conversation-tree.zh.md)

## Abstract

Stopping one turn does not prevent another agent's late result from waking it.
The related-conversations panel now confirms a tree-wide stop and persists a
user-owned barrier, enforced by execution and completion delivery. Explicit
restoration is required, including before manual execution; ordinary messages
cannot accidentally reopen collaboration. Offline machines stop after sync,
so this is not an atomic cancellation across machines.

## Decision and ownership

The renderer discovers the complete tree from authoritative metadata, checks the
machine capability, stops the root first and restores it last. It includes hidden
and archived descendants and cancels locally pending sends. The CLI checks live
ancestry before setup and prompt dispatch, cancels exact active turns with queue
preservation, rejects further MCP delegation, and consumes late completions without
starting a continuation. Agents cannot clear the barrier. Creation/containment
edges define scope; arbitrary message recipients do not become tree members.

Repeated ordinary Stop calls were insufficient because late delivery starts a new
turn. Automatically restoring on a human message was considered but left out to
avoid releasing old collaboration unexpectedly. This adds persisted state and an
explicit restore action. It complements the [16-hop limit](../bug-fix/2026-10-11-bound-agent-message-chains.md).
The [orchestration Spec](../../../../specs/session-orchestration.md) remains draft.

## Evidence and limits

Behavioral suites cover authoritative tree selection, unsupported-machine refusal,
inherited late descendants, confirmation/cancel/restore, and suppressed completion
replay. The component was rendered and captured in Chinese through Storybook.
Full workspace checks are limited by missing dependencies in this nested checkout;
PR validation lists the exact checks and failures. Cross-machine deployment and
offline reconnection have not been verified end to end.

PR: https://github.com/LodyAI/Lody/pull/1428
