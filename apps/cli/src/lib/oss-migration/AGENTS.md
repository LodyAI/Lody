# OSS migration

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

- The cloud CLI imports a frozen OSS snapshot into an explicitly selected existing
  workspace. Never attach cloud transport to the source or open its SQLite writable.
- Preflight all document IDs, supported history backends and index collisions before
  uploading. A target tombstone is a collision, not permission to resurrect.
- Publish session metadata only after complete bodies are remotely verified. Imported
  sessions are collaboration-stopped; schedules are disabled; command queues never migrate.
- Preserve full Loro operation history and opaque stored history. Reuse the shared
  HistoryWriter for attachment edits. Never export user-facing JSON as a CRDT backup.
- Journal account, deployment, target and source identity. Replays use frozen prepared
  bytes; already published records are never overwritten with the source again.
- Never copy installation login/keychain credentials, change cloud configuration, delete source data, or treat an
  unknown storage format as empty. Empty unowned streams fail closed.
- Create streams with their receipt atomically. Use server append-cas for all shared
  index/meta writes; never fall back to sync/ordinary append for conditional mutations.
  Discard tentative replicas on mismatch. Persist per-row receipts in the same sub-Flock
  append so retries preserve later user edits and tombstones.
- Scan historical attachment references, freeze and validate all bytes before writes,
  scan descriptor write runs rather than intermediate field states; all recovered
  descriptors must match immutable bytes (never select history by disk contents), and retain HEAD archive mappings without rewriting historical CRDT operations.
- Wire process SIGINT/SIGTERM into the lock and Effect cancellation signal.
  Propagate interruption into network signals, bound waits, and await cancellation
  cleanup. Only short local checkpoints may defer interruption; never mask uploads.
