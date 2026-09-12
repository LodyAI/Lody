# Usage delivery

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

- Grok updates are prompt totals: preserve each payload in order until acknowledged.
  Do not coalesce them as cumulative snapshots or infer hosted aggregation from a method name.
- Failed delivery retains the exact payload ahead of newer updates. Concurrent flushes
  share one drain; rejection waits for a later flush instead of spinning.
- Keep cumulative-provider coalescing and Codex compaction separate from Grok delivery.
  Never turn unknown Grok costs into zero while queueing or retrying.
- The queue is process-local; it is not a restart-safe ledger. Local composition still
  has no cloud usage service. See [delivery Spec](../../../../../specs/usage-delivery.md).
