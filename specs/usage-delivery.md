# Client usage delivery

Status: draft
Translation: current

[中文](usage-delivery.zh.md)

When several Grok prompts finish while cloud delivery is unavailable, a later
flush must send every accepted prompt's usage in order. The latest prompt must
not replace earlier prompts. Token buckets and absent costs retain their meaning.

The client queues Grok prompt totals without changing the hosted request shape
or inventing session totals. Other providers retain their existing snapshot
coalescing and Codex compaction handling. Queue ownership is isolated by workspace,
Lody session, ACP session, and user; each payload retains its attribution.

A successful `{success:true}` response removes that payload. Rejection, exception,
or unsuccessful acknowledgement leaves it ahead of newer updates for the next
flush. Concurrent flushes share one drain; a failure ends that attempt. New updates
arriving during a successful drain are sent by the same drain. Missing model usage
still prevents persistence, but cannot block later valid records.

This is process-local delivery, not durable accounting. It cannot restore usage
lost before the fix, survive process exit, correct upstream partial snapshots, or
establish the hosted service's delta/snapshot or ambiguous-acknowledgement semantics.
Those contracts need separate verification; this change preserves the ordinary
per-prompt request sequence rather than selecting a new aggregation rule.
OSS local composition continues to disable cloud usage entirely.

## Evidence

- [Implementation and behavioral tests](../apps/cli/src/lib/usage/usage-tracking-service.test.ts)
- [Research and remaining limits](../.agents/notes/proposed/bug-fix/2026-09-12-grok-token-accounting.md)
