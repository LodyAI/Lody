# Usage delivery

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

- Accounting uses Core cumulative `modelUsage`; optional `delta` is already included.
  Coalesce pending snapshots, including Grok; never add delta to cumulative totals.
- Failed delivery retains the exact payload ahead of newer updates. Concurrent flushes
  share one drain; rejection waits for a later flush instead of spinning.
- Keep legacy Codex compaction separate. Never turn unknown costs into zero
  while queueing or retrying; adapters own request-level price estimates.
- The queue is process-local; it is not a restart-safe ledger. Local composition still
  has no cloud usage service. See [delivery Spec](../../../../../specs/usage-delivery.md).
