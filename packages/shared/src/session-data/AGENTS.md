# Session history

`CLAUDE.md` is a symlink to this file. Parent guidelines apply.

- `HistoryWriter` is the only history writer. Reuse its validation, changed-field
  diff, legacy representation, stored-copy and conditional rollback rules.
  Shared business rules live in the planners, not in UI or CLI copies.
- Directory reads contain identities, scalars and input configuration, never
  bodies. Targeted reads materialize only the selected turn. Status queries use
  the directory; explicit export/replay uses one consistent `readAll` observation.
  `readTurnOutput` reads the selected assistant and relevant failure notices in
  one observation instead of serializing the transcript on every token.
- Repeated identity lookups reuse an unchanged pending transaction. Reads must not
  commit writes; uncommitted structural/ID edits and checkout still invalidate lookup.
- Subscribe and capture the initial directory without a gap. Notifications carry structural ranges or changed turn ids. The display
  cache rejects stale async reads. Turn ID edits (including deletion) are structural:
  notify by position so readers can remove the old identity before re-keying. CLI reads in-process synchronously; auto-seen
  scans directory scalars only and permission checks have no await gap.
- Ordinary commands propagate writer errors; absence returns a boolean where the
  caller needs it. Only import and editable-tail replacement use phased results:
  `rejected` proves no write; `indeterminate` must not be retried automatically.
  The repo owns persistence and remote convergence barriers.
- A snapshot is the HistoryWriter's detached, unforgeable stored-copy handle.
  Its existing provenance WeakMap is authoritative. Source disposal does not
  invalidate a capture held by a fork. Do not add a second handle registry,
  backend capabilities, store tokens or source-lifetime coupling.
- Tail replacement rechecks the expected user/provider boundary and active goal
  inside the write. Await conditional rollback before persisting follow-up meta;
  rollback retains later appends and refuses to overwrite concurrent edits.
- Import inputs are explicit data. Recheck current history/cursor and bind the
  stored baseline and cursor in the same synchronous write, without an await gap.
  A cursor failure after history mutation is indeterminate.
- Legacy inline rows and unchanged unknown fields survive updates. Never rewrite
  history while opening or reading. Auto-seen is a separately attached CLI policy
  with a commit-time guard against regressing an advanced execution status.
- Test the real Loro reader and writer. Delayed reads use small injected Promise
  gates; there is no test-only implementation of the complete command API.
