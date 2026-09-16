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
- Codex turn snapshots carry notification-local `_meta.codex.usageTurnId`.
  The provider parser passes a stable native-session/turn accounting identity to
  delivery; never overwrite the real ACP session ID or session metadata.
  Coalesce within a turn identity, never across turns. Unmarked adapters retain
  their existing cumulative identity. No CLI reset offsets or model guessing.
  Preserve provider costs; unknown tariffs remain unknown.
- The queue is process-local; it is not a restart-safe ledger. Local composition still
  has no cloud usage service. See [delivery Spec](../../../../../specs/usage-delivery.md).
