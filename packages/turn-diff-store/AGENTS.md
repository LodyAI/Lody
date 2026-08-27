# Turn Diff Store

`@lody/turn-diff-store` is a local-only content-addressed snapshot store. It has no
Loro, Flock, session-schema, or network dependency.

## Invariants

- Public calls are async. Production callers pass the emitted worker entry URL so
  FastCDC, hashing, compression, SQLite reads, and reconstruction stay off their
  main thread. `TurnDiffStore` requires a worker URL; the separate `./sqlite`
  entry provides an explicit inline backend for tests and embeddings that already
  own a worker thread.
- A turn and all of its file records commit atomically. Retrying the same
  `(ownerId, turnId, path)` is idempotent and keeps the first durable event.
- `orderKey` is stable turn-history/GC order; `capturedAtMs` anchors retention and
  `recordedAtMs` is calibrated caller time for expiry checks. Worker and inline clients
  inject one clock, and every retention read plus startup/background/manual GC forwards
  an explicit `nowMs`; the low-level SQLite store never falls back to `Date.now()`.
  Expired or size-evicted turns reject later partial writes. Size GC retains tiny ordering
  tombstones until retention expiry.
- Missing files are represented explicitly with a null snapshot reference; an empty
  file is a real SHA-256-addressed zero-byte snapshot.
- Snapshot refcounts cover turn old/new references plus path heads. Chunk refcounts
  cover snapshot-manifest occurrences. Refcount changes and owning rows must be in
  the same SQLite transaction. Record/GC cleanup must inspect only snapshot ids whose
  refs changed; never restore a full zero-ref table scan to the per-turn write path.
- Path heads survive retention GC because Code Collab needs the last recorded text
  to chain edit-only evidence into the next turn. They are not returned by historical
  listing APIs. A caller allocates one durable attempt-start `headProof`; only a path
  whose `newText` was verified against current disk state may consume it. Larger proofs
  win, so an older attempt that commits late cannot roll a head back. Under size pressure,
  old heads are the second reclaim tier after old turns.
- Each workspace database starts size GC above 1 GiB and targets 900 MiB by evicting
  complete oldest turns, then oldest heads. The globally newest turn and heads sourced
  by it are protected, so live evidence can form an honest floor above the target.
- Background GC yields between batches of at most 128 turn/head rows and incremental-
  vacuum steps. One turn may own many references, so this bounds rows, not strict CPU
  work per step.
- SQLite uses WAL, `synchronous=FULL`, foreign keys, incremental auto-vacuum, gzip
  level 1 by default, and a single worker-owned connection. zstd level 1 is explicit
  opt-in only when every reader runtime supports it.
- `better-sqlite3` requires Node-API 10 (Node 22.14+, 23.6+, or later) and x64 or
  arm64; the SQLite entry fails before loading the addon on unsupported runtimes.
- Reads verify reconstructed snapshot SHA-256 and run selection + reconstruction in a
  short read transaction. Bounded reads check manifest `raw_size` before allocating,
  decompressing, or crossing the worker boundary. `PRAGMA application_id` owns new
  databases; only the exact legacy Loro fingerprint is accepted without that marker.
  Initialization classifies the complete `sqlite_master` schema while holding `BEGIN
IMMEDIATE`; unowned lookalikes are never modified, and owned resets/version writes are atomic.
- The current pre-FastCDC Loro schema is intentionally replaced in place. Do not add
  a partial reader or mix the two schemas.

GC tests use deterministic data. Background-GC tests wait on its completion callback,
never sleeps, wall-clock races, or scheduler timing.
