# Catalog cache and recovery

The first phase-3 slice keeps one app module and adds no library dependencies. Product navigation and message history are a later slice. The current debug cloud screen demonstrates cached state and recovery.

```text
AccountController ── AccountContextStore
       │ verified / cached identity
       ▼
CatalogRepository ── CatalogStore (AtomicFile, IO mutex)
       │                    ▲
       │ selected scope     │ conflated synchronized snapshots
       ▼                    │
RuntimeOwner ── stamped RuntimeEmission ── display StateFlow
       │
ReadOnlyCloudRuntime → WebView + unchanged shared CRDT runtime
```

The repository is the sole directory display owner. It restores the chosen workspace and its projection before acquiring a grant; cached account metadata is never sufficient to authorize a grant. Account context is only restored when native credential material is present. Server validation then updates membership, and a transient network failure retains the unverified cached display. Logout, revocation and account switching stop the old scope before clearing the owned cache.

Atomic files suit this slice because reads and writes replace entire snapshots; there are no relational queries yet. A narrow suspend interface permits a later Room implementation without changing pages or the runtime. Scope filenames are SHA-256 hashes, writes are atomic, input is capped at 8 MiB per projection and 1 MiB for account context, and at most eight workspace projections are retained. Files live under noBackupFilesDir. This is private display data, not encrypted credentials or a second CRDT replica.

Only a matching catalog/synced pair updates and persists the live display. A cache read is always explicitly marked cached. A new runtime generation can legitimately restart its revision at one. Generation is stamped at native receipt, before coroutine queues, and checked again at the repository. An independent scope-owned conflated persistence worker keeps slow disk IO out of the cloud event path; teardown cancels and joins that worker before cache deletion. Failed cache writes leave cloud reads active and expose a separate cache warning.

RuntimeLifecycle registers one network monitor for the process. Foreground validation wakes an unavailable read lease; background validation is considered only on foreground return. A validated network does not make a catalog LIVE. Replacing a failed read lease obtains a new grant and exact gateway permission, without replaying writes. The shared runtime still owns its own retry policy. Grant receipt time is retained with a monotonic clock, and delivery uses remaining lifetime instead of resetting the full TTL.

Debug-only connection traces emit fixed stage labels and elapsed milliseconds; they never include URLs, workspace identifiers, tokens or catalog bodies. They distinguish native grant time from shared-runtime bootstrap stages. The previously observed two-minute recovery may include several retry/timeout intervals; it is not evidence for one specific network/server cause. Actual measurements are recorded in verification/phase-3-cache-results.json.

Checks cover account revocation/cancellation, credential-free restore, atomic persistence/reopen/corruption, scoped events, cache-write failure, delayed disk IO, queued old-generation events and lifecycle recovery. Natural server-token expiry, sustained reliability and the physical-device matrix must be described separately from deterministic regression results.
