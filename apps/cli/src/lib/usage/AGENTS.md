# Usage delivery

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

- Accounting uses Core cumulative `modelUsage`; optional `delta` is already included.
  Coalesce pending snapshots, including Grok; never add delta to cumulative totals.
- Project persistence payloads to token/cost fields; only aggregate usage retains
  contextWindow. Do not forward webSearchRequests or other provider-only fields.
- Usage eligibility follows the builtin catalog, including `deepseek`, not the
  managed-runtime download catalog. Local composition still has no cloud service.
- Failed delivery retains the exact payload ahead of newer updates. Concurrent flushes
  share one drain; rejection waits for a later flush instead of spinning.
- Keep legacy Codex compaction offsets across acknowledged flushes, separate from
  adapter-owned cumulative updates carrying delta. Never turn unknown costs into zero
  while queueing or retrying; adapters own request-level price estimates. Preserve
  provider costs; omit estimates when cache-write pricing is unavailable.
- The queue is process-local; it is not a restart-safe ledger. Local composition still
  has no cloud usage service. See [delivery Spec](../../../../../specs/usage-delivery.md).
