# Migrating Lody to loro-repo's replica-safe Flock persistence

Status: implemented
Translation: current

[中文](2026-09-27-loro-repo-flock-persistence-migration.zh.md)

## Abstract

loro-repo 0.20.0 treated the Flock version vector as proof that everything below it had been saved. Lody added three cursor/data mismatches of its own: the CLI saved Streams cursors before the matching SQLite write, one-shot CLI commands resumed from the daemon's cursor rows, and web tabs shared one repo database and one cursor database. Each could make a replica skip remote data permanently. Lody now binds every Meta/Flock Streams checkpoint to the replica that loaded it and stores the checkpoint atomically with that replica's data: IndexedDB in the renderer, SQLite in the CLI. Each cursor is saved only after a real per-resource persistence barrier, and LoroDoc cursors are shared and durable only in the daemon. It shipped in three PRs: the library upgrade (#1049), the renderer (#1058), and the CLI on loro-repo 0.21.0 (#1066). No cursor was migrated. Each Meta/Flock room bootstraps once on its first 0.21.0 open, which also repairs caches that were already damaged; while an older release keeps writing, affected rooms can bootstrap again. Remaining limits: durability is proven with fake-indexeddb, real-Chromium ordering and injected SQLite failures, not power loss; and LoroDoc cursors are not bound to a replica, so a one-shot command bootstraps each document it opens.

## Upstream change (0.20.0 → 0.20.3, `main` at `5862a2b`)

Evidence is from the loro-repo repository. Its design record is `docs/flock-persistence.md` (PR #132).

- **Journal replaces version tracking.**
  - `FlockPersistenceJournal` replaces the version-vector bookkeeping in `MetaPersister` and `FlockDocManager`.
  - Local changes are written as exact `getEntry` records.
  - Payloads received through Streams (`applySnapshot`/`applyRemoteUpdates`) are appended verbatim, JSON or binary.
  - A payload leaves the queue only after `storage.save` resolves. After three failures of the same encoding it is replaced by a full-file fallback.
- **Snapshot saves are mergeable, not destructive.**
  - `meta-snapshot` and `flock-doc-snapshot` saves are now mergeable inputs in the IndexedDB, SQLite and filesystem adapters.
  - Only checked compaction replaces a base, and it removes only the updates it captured.
  - Update logs may now mix JSON records and binary Flock files.
  - 0.20.0's `hydrateMetaSnapshots` already merges both formats, so a rollback can still read the new data.
- **IndexedDB schema.**
  - The schema moves from version 3 to 4 and adds a `replica-checkpoints` object store: one `{ generation, cursors[] }` record per Meta or named Flock resource.
  - `loadMetaReplica` and `loadFlockDocReplica` capture base, log and checkpoint in one transaction. If no generation exists, they create one inside a readwrite capture.
  - Flock data and checkpoint writes use `durability: "strict"`.
  - 0.20.0 opens a database without a version first, so an old build can open a v4 database and simply ignores the new store.
- **Streams persistence factory.**
  - `createRepoStreamsPersistence(repo, options?)` returns `mode: "replica-bound"`. It requires the two replica loaders, so today it works only with `IndexedDBStorageAdaptor`.
  - Replica-bound mode cannot be combined with the `remoteCursorStore` option.
  - LoroDoc cursors are memory-only unless `documentRemoteCursorStore` is supplied.
  - In this mode the transport no longer deletes Meta/Flock cursors itself; they belong to the storage.
  - The two-argument form still works but is deprecated. It keeps data-before-cursor ordering, not atomic recovery.
- **SQLite.**
  - `SqliteRepoStore` has no schema change and no replica capability.
  - Corrupt cursor rows are dropped instead of failing (#102).
- **Other changes that affect Lody.**
  - `ready()` starts the metadata live monitor (#126, 0.20.1). That makes `patches/loro-repo.patch` redundant.
  - Transports now close before resource managers.
  - IndexedDB failures become `RepoStorageError` with a `code` (#129).
  - The unreleased 0.20.4 (#134) removes redundant version-vector reads on Streams imports.
  - All required Flock APIs (`recoverFromFile`, `inclusiveVersion`, `getEntry`) exist in `@loro-dev/flock-wasm` 0.4.3, which Lody already pins.

## Lody's current composition

**Renderer**

- The repo lives in IndexedDB database `lody-loro-repo-db-<ns>` (`packages/components/src/providers/create-workspace-runtime.ts:431`).
- Cursors live in a separate database, `lody-loro-stream-cursors-<ns>`, behind a resilient wrapper that falls back to memory after a 2-second timeout (`:457`, `resilient-remote-cursor-store.ts`).
- The Streams adapter passes that store as `remoteCursorStore` and awaits a full `repo.flush()` in every `onPersist*` callback (`:2817-2846`).
- Meta-cursor recovery deletes the Meta URL from that store (`:712-747`). A `localStorage` marker bypasses its load on the next start (`:443-456`).
- The namespace is `<workspaceId>`, or `<workspaceId>:<windowId>` for auxiliary Electron windows (`:159-173`).
- The primary Electron window and every web tab use the bare workspace namespace.

**CLI**

- One `SqliteRepoStore` per workspace at `<dataDir>/loro-repo/<ws>/repo.sqlite3`. It supplies both the repo storage and, through `AliasedRemoteCursorStore`, the cursor store (`apps/cli/src/lib/loro/sqlite-repo-store.ts:64-83`).
- The Streams adapter uses the legacy `remoteCursorStore` + `onPersist*` options (`apps/cli/src/lib/loro/streams-transport.ts:39-61`).
- Those callbacks only schedule a coalesced flush (200 ms debounce) and resolve at once (`apps/cli/src/lib/loro/doc.ts:614-622,756-783`).

**Barrier timing.** In streams-crdt 0.15.1, `persistRemoteCursor` awaits the barrier and then saves the cursor inside the read path (`finalizeCursor`). A slow barrier therefore delays that room's next batch but never drops it.

## Mismatches found

1. **CLI cursor ahead of data (confirmed from code, not reproduced).**
   - The cursor save runs while the covered state may be only in memory.
   - If the daemon crashes or is killed inside the debounce-plus-flush window, `remote_cursors` is left ahead of the SQLite data.
   - The restart resumes past the missing entries and keeps that hole until something forces a bootstrap.
2. **CLI processes share cursor rows (plausible, not reproduced).**
   - One-shot commands open the daemon's SQLite file and attach Streams on creation (`apps/cli/src/lib/command-runtime.ts:246`).
   - Each process hydrates its own in-memory replica but reads the shared `remote_cursors` row when it joins a room.
   - A process that hydrated before the daemon advanced data and cursor would resume at the daemon's tail. That is the upstream "stale replica, shared cursor" case.
   - Automatic snapshot upload is enabled (`canUpload: true`, 5 s debounce). Upstream showed that this case can publish a snapshot missing remote entries if the process lives past the debounce.
3. **Web tabs share one repo database and one cursor database.** This is exactly upstream's deterministic shared-IndexedDB reproduction. The Electron primary window normally has a single instance, but nothing enforces that on the web.
4. **The persistence hole in 0.20.0 affects every Lody replica.** Upstream fixed it in #132.

**Adjacent, out of scope.** The local data plane sends Flock deltas as `exportJson(from: version())` (`packages/shared/src/local-loro-transport.ts:578-580`, `local-loro-data-plane-server.ts`). It relies on the same "equal version vector means complete" assumption, so it cannot repair a same-version hole between the renderer and CLI replicas. It needs its own decision.

## Proposal

### Phase 0: library upgrade only

- Bump `loro-repo` to 0.20.3, or 0.20.4 once it is released, and delete `patches/loro-repo.patch`.
- Keep every composition unchanged: the renderer keeps its separate cursor database, the CLI its legacy options.
- What changes:
  - the journal replaces version-based skipping;
  - IndexedDB upgrades to v4;
  - SQLite needs no migration.
- **Rollback:** reverting the package is safe. 0.20.0 can open v4 and read mixed logs, and cursors are untouched.
- **Checks:**
  - `doc-meta-subscription.test.ts` still passes without the patch;
  - nothing in Lody matches IndexedDB error text;
  - `RepoStorageError` is logged usefully;
  - the storage-growth and compaction behavior of appended bootstrap files is observed on a large workspace.

**Phase 0 as implemented ([LodyAI/Lody#1049](https://github.com/LodyAI/Lody/pull/1049)).**

- The catalog now pins exactly `loro-repo: 0.20.3`, and the patch is deleted.
- `main` had meanwhile moved to streams-crdt 0.16.0 ([streams-crdt 0.16 upgrade](../../implemented/bug-fix/2026-09-27-streams-crdt-0.16-upgrade.md)). Its package-specific peer exception therefore moves from `loro-repo@0.20.0` to `loro-repo@0.20.3`.
  - 0.20.3 wraps two streams-crdt pieces: `createFlockAdapter`, and `persistRemoteCursor` with its `finalizeCursor` caller.
  - The emitted code of both is identical in the 0.15.1 and 0.16.0 tarballs.
  - The pin is exact so that a later patch release cannot fall outside that exception unnoticed.
- The installed 0.20.3 `ready()` awaits `ensureMetaLiveMonitor()` before starting the persister, which is exactly what the patch did.
- **Cross-version check** (throwaway script, not committed):
  - Both published 0.20.0 and 0.20.3 ran against one fake-indexeddb database and one `SqliteRepoStore` file, alternating old → new → old → new → new.
  - At every step each version saw every document metadata entry and named-Flock key written by the other.
  - The IndexedDB database ended at version 4 with `replica-checkpoints`.
  - This supports the rollback claim above for data written without cursors. It does not cover mixed-version concurrent writers.
- The large-workspace storage-growth observation is still open.
- **Correction: strict durability already applies in Phase 0.**
  - 0.20.3's `IndexedDBStorageAdaptor.openTransaction` requests `durability: "strict"` for every readwrite transaction that touches the meta or named Flock stores, whether or not cursors are replica-bound.
  - The renderer's `onPersist*` → `repo.flush()` barrier therefore pays a strict commit per cloud sync event from Phase 0 on.
  - The strict-transaction gate listed under Phase 1 must be measured before Phase 0 ships widely, not after.
- **Journal memory under persistent storage failure:** while `storage.save` keeps rejecting (for example, an exceeded quota), the journal keeps every received payload copy. The three-attempt full-file fallback does not bound that growth if the fallback save also fails. Previously only a version vector was retained.

**Phase 0 risk simulations (2026-09-27).** All used the published 0.20.0 (with the Lody patch where relevant) and 0.20.3 packages. The IndexedDB cases ran in real Chromium: an Electron 39.5.1 renderer with Node integration on macOS arm64.

| Risk                                                                          | Result                                                                                                                                                                       | Verdict                                                                                        |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Strict durability, one barrier (meta + one Flock, 5k docs, 300 events)        | `repo.flush()` p50 0.6 → 8.1–8.6 ms. With strict stripped, 0.4 ms. Main-thread lag ≤ 3.3 ms. All writes persisted.                                                           | Real cost in cloud and dual modes only; not a correctness issue                                |
| Strict durability, 11 rooms flushing together                                 | p50 2.0 → 44 ms, p95 about 60 ms. Single-flight coalescing of barriers does not help, because one flush costs about 3.7 ms per dirty resource.                               | Needs upstream batching: [loro-repo#140](https://github.com/loro-dev/loro-repo/issues/140)     |
| Local-only desktop (11 Flocks, 220 updates/s over the data plane, no barrier) | Zero backlog after the burst, main-thread lag ≤ 4.5 ms in both versions, every room persisted. All ~1,100 transactions are now strict.                                       | No latency impact; only more disk syncs                                                        |
| IndexedDB v3→v4 while a 0.20.0 connection is open                             | Upgrade takes 11.8 ms without `blocked`. The old connection reopens at v4 on its next write. Both versions read all writes afterwards.                                       | Ruled out                                                                                      |
| More `doc-metadata` watch events                                              | Identical counts for 0.20.0 + patch and 0.20.3 across remote imports (with and without an immediate read), local writes, no-op echo and a 50-doc bulk import.                | Ruled out                                                                                      |
| Bootstrap storage growth (SQLite)                                             | 0.20.3 appends a received snapshot verbatim (37 KB versus 0.8 KB of changes), once. A repeated identical bootstrap appends nothing, and compaction returns to 0.20.0's size. | Bounded: at most one snapshot until compaction                                                 |
| Journal memory while saves fail                                               | Pending bytes equal genuinely new incoming bytes (1,465 KB in, 1,465 KB queued). When healthy, only the unflushed tail remains (14 KB).                                      | Bounded by real traffic during the outage                                                      |
| Opening under a full disk                                                     | Once at v4, the database still opens read-only. The first open after the upgrade fails, which 0.20.0 also does when it has pending compaction.                               | Not a regression; tracked in [loro-repo#139](https://github.com/loro-dev/loro-repo/issues/139) |

Separately, a real full disk makes the CLI daemon exit through an uncaught log-transport `ENOSPC` in both versions. See [#1054](https://github.com/LodyAI/Lody/issues/1054).

### Phase 1: renderer replica-bound checkpoints

- Replace `remoteCursorStore` + `onPersist*` with:

  ```ts
  persistence: createRepoStreamsPersistence(repo, {
    documentRemoteCursorStore: remoteCursorStore,
  });
  ```

  - LoroDoc cursors keep their current store and alias handling.
  - Meta and named Flock cursors move into the repo database, so the web-tab and window cases become safe by construction.

- Replace the barriers: per-resource `persist*Now` calls replace the full `repo.flush()` that currently runs on every sync event.
- Rewire Meta recovery to delete through `repo.getReplicaCheckpointStore({ kind: "meta", flock: repo.getMeta() })`.
  - Deleting the old cursor-database entry would have no effect.
  - The startup `localStorage` bypass becomes a delete of the Meta checkpoint before the cloud transport attaches, because the checkpoint is captured when the repo is created, not loaded lazily.
- **Do not copy existing Meta/Flock cursors into checkpoints.** A copied cursor has exactly the property the change removes: progress not captured with the data.
  - The empty generation makes each room bootstrap once and merge. That repairs historical holes whenever the remote snapshot is complete.
  - Old cursor-database entries are left alone. A rollback build would resume from those older offsets, which only causes a harmless replay.
- **Cost gates before shipping:**
  - bootstrap count and bytes when a large workspace opens for the first time;
  - strict-durability transaction rate and main-thread and disk time under a busy Meta stream on macOS Chromium.
  - If strict writes are too expensive, fall back to Phase 0 behavior. Do not relax the ordering.
- **Checkpoint key (limit):** it is the opaque stream URL, so a gateway-origin change forces bootstraps where `getLoroStreamsRemoteCursorUrlAliases` used to avoid them. Keying checkpoints by `(bucketId, streamId)` would need an upstream change.

**Phase 1 as implemented ([#1058](https://github.com/LodyAI/Lody/pull/1058); works with the pinned 0.20.3).**

- **Wiring.** `workspace-streams-transport.ts` builds the renderer transport with `createRepoStreamsPersistence(repo, { documentRemoteCursorStore })`. The resilient per-window cursor database now serves LoroDoc rooms only.
  - Each room's barrier is its own `persist*Now`, not a full `repo.flush()`. That also removes most of the multi-resource strict-commit cost measured under Phase 0, because a barrier commits only its own resource.
- **Meta recovery.** `invalidateMetaRemoteCursor` deletes the Meta checkpoint through `repo.getReplicaCheckpointStore({ kind: "meta", flock: repo.getMeta() })`.
  - The `localStorage` bypass marker now deletes that checkpoint before the cloud transport attaches.
  - The resilient store's now-unused `shouldBypassPrimaryLoad` option and its test are removed.
  - Both deletions use `getWorkspaceMetaStreamUrl`, the same key the transport writes.
- **`tests/workspace-streams-transport.test.ts`** (real `IndexedDBStorageAdaptor` and resilient cursor store on fake-indexeddb, scripted Streams server):
  - A tab that hydrated before a sibling tab advanced the shared databases bootstraps instead of resuming at the sibling's tail (mismatch 3).
  - Deleting at the runtime's Meta key makes the next sync bootstrap.
- **Ablations.**
  - The pre-change wiring (shared cursor database plus a `repo.flush()` barrier) fails both tests.
  - A drifted Meta key fails the recovery test.
  - Dropping the startup deletion fails the new marker test in `create-workspace-runtime-meta-recovery.test.ts`.
- **Test-isolation fix.** That file's tests now stub `globalThis.localStorage` per test. The runtime reads it, and a bypass marker from one test previously leaked into every later one.
- **Review fix (P1).** Deleting the suspect Meta checkpoint is now a hard precondition of the cloud attach, on both the web and dual paths.
  - If the delete rejects (for example, the IndexedDB connection is closing), the attach fails, the marker is kept, and the existing attach/reconnect paths retry. Previously the failure was swallowed, the transport resumed from the suspect checkpoint, and the next successful sync cleared the marker for good.
  - Runtime invalidation latches its one-shot flag only after a successful delete.
  - The marker is cleared only once this page lifetime has actually deleted the checkpoint.
  - Regressions: for both web and dual, a rejected delete means no `addTransport('cloud')` and the marker survives; the next attach deletes first, then attaches. Both fail against the reviewed head.
- **Review fix (P1, web retry).** Web attaches only from `setAuthToken` and meta recovery, so a failed first attach under an unchanged token had no reachable retry. The local reconnect loop requires an attached transport, and no room tracker exists yet.
  - A web attach failure is now recorded explicitly, and `webAttachReconnectLoop` retries it under the shared backoff. That covers the token-change path and the meta-recovery restart path.
  - A same-token `setAuthToken`, network/visibility wake and the backstop also trigger the retry. Token change, offline and dispose stop it.
  - Regressions: same-token retry, backoff-only retry (delete strictly before attach, marker cleared after Meta sync), and no pending retry timer after dispose. Each fails when its mechanism is removed.
- **Review fix (P1, token rotation during a blocked attach).** The single-flight web attach let a new token share an in-flight attach from the previous token. That attach had already lost its provider to the rotation's teardown, yet it still published the transport, leaving an attached runtime with no token provider.
  - Every `teardownTransport` now bumps a web attach generation synchronously; it does not await the attach, which may be blocked on the delete.
  - An attach re-checks its generation after `prepareStreamsAccess`, after the checkpoint delete and after `addTransport` (removing the transport it just added). A superseded attach publishes nothing and records no retry.
  - Sharing is limited to one generation. A newer generation never waits for an older attach, which may be stuck on the delete or on room routing; it builds its own provider and transport at once.
  - loro-repo registers a transport as soon as `addTransport` starts. Teardown therefore records, together with the generation bump, whether any web cloud add is in flight, and removes that transport before sign-out or dispose returns.
  - Because generations do not wait for each other, adds of several generations can overlap. In-flight adds are therefore tracked per generation, and each clears only its own entry; with a single flag, an older add finishing would hide a newer in-flight add from the next sign-out.
  - Teardown stops the web retry loop and drops its pending attempt synchronously, right after the generation bump and before its first await. Every retry path (the loop, wake edges, same-token replay) needs a pending attempt. Otherwise a wake edge during teardown's awaits could start an attach in the new generation, reusing the provider the teardown then invalidates, and leave the runtime attached with no provider.
  - The attach's error path is fenced as well: a superseded attach that later fails with an ordinary error is converted to a supersession. It must not emit analytics, stop the next generation's presence, or record a retry. The superseded add does not remove `cloud` again when it finally resolves, so it cannot hit the next generation's transport of the same id.
  - Regressions:
    - Rotating t1→t2 while the delete is blocked attaches t2 before the old delete is released, exactly once, and `ensureDocStream` works.
    - Dispose or sign-out during a blocked delete never attaches, joins or retries.
    - With `addTransport` held, sign-out and dispose have already removed the cloud transport when they return.
    - A superseded add that resolves after the next token attached does not remove that token's transport.
    - With two adds in flight, the older finishing first still leaves the next sign-out to remove the newer one before returning.
    - A superseded attach whose delete or add later fails with an ordinary error leaves presence and retries alone, and the next token's `ensureDocStream` still works.
    - A wake edge while a token-change teardown is held in its first await starts no attach, and the new token's own attach leaves `ensureDocStream` working.
    - Each of these fails when its mechanism is removed.
- **Review fix (P1, dual marker).** The dual runtime watches its local Meta binding, which usually synced before the cloud plane attached, so the marker was never cleared. Every later cloud attach deleted a valid cloud checkpoint and bootstrapped again.
  - In dual mode the marker is now cleared only by the cloud Meta binding's first sync, and only while that tracker is still current and the same cloud attach deleted the checkpoint.
  - The local binding's success clears it only on the web.
  - A detach, or a new suspicion marker, resets that per-attach proof.
  - Regressions: delete, then cloud first sync, clears the marker. A replaced cloud session's late first sync, after a later attach failed to delete, keeps it. Each fails when its guard is removed.
- **Merge gate for the web.** Mixed-version tabs need loro-dev/loro-repo#138. Electron runs one bundle for all windows, so it is exposed only on rollback.

### Phase 2: real CLI barriers (independent of upstream)

- Replace the schedule-only callbacks with awaited per-resource barriers, via the deprecated `createRepoStreamsPersistence(repo, aliasedCursorStore)` or an equivalent bundle:
  - `persistMetaNow`
  - `persistFlockDocNow(id, flock)`
  - `persistDocNow(id, doc)`
- These write only the pending journal entries or document delta, not the whole repository. That was what made the 3.6 flushes/s × 61 ms `repo.flush()` too costly and led to the coalescer.
- Keep the coalescer for non-barrier persistence.
- **Measure** barrier latency per batch and catch-up throughput on a long session before merging.
- **This fixes mismatch 1 only.** Mismatch 2 remains, because the cursor rows are still shared.

### Phase 3: CLI SQLite replica-bound checkpoints (upstream prerequisite)

- **Upstream work in `SqliteRepoStore`:**
  - Implement `loadMetaReplica` and `loadFlockDocReplica` with a `replica_checkpoints(resource_key PRIMARY KEY, generation, cursors_json)` table.
  - Capture snapshot + updates + checkpoint in one better-sqlite3 transaction.
  - Check the generation in each cursor write.
  - Delete the checkpoint row in the same transaction as `deleteFlockDoc`, which covers retention expiry of `fi`/`fis`.
- **Lody then switches** to `createRepoStreamsPersistence(repo, { documentRemoteCursorStore: aliasedCursorStore })`. Each process, daemon or one-shot, gets its own captured cursor, which closes mismatch 2.
- **Migration:** `CREATE TABLE IF NOT EXISTS`, no copying of `remote_cursors`, and one bootstrap per Meta/Flock room.
- **Rollback:** an older build ignores the new table and resumes from stale `remote_cursors` rows (replay only). A checkpoint that is behind the data is always safe.
- **One unsafe rollback sequence:**
  1. An older build deletes a named Flock, which leaves its checkpoint row behind.
  2. The newer build reopens the empty document with the stale cursor.
  3. The earlier stream history is then skipped.

  The upstream design must close this. For example, each checkpoint could record a fingerprint of the base/log it was captured with, so a mismatch discards the checkpoint. The same gap exists for IndexedDB, but no renderer code deletes named Flocks.

- **Upstream status:** [loro-dev/loro-repo#137](https://github.com/loro-dev/loro-repo/pull/137) implements this capability. It merged after review and shipped in loro-repo 0.21.0 together with #138 (IndexedDB lineage marker) and #141 (one strict transaction per flush).
  - It closes the rollback gap with delete triggers stored in the database schema rather than fingerprints. Deleting a base row, or deleting update rows while no base row exists, drops the checkpoint.
  - This works because every SQLite writer since #99 removes Flock data only through `deleteFlockDoc` or through compaction, and compaction writes the base before deleting updates. The triggers therefore also fire for older binaries without mistaking compaction for deletion.
  - Base rows switch from `INSERT OR REPLACE` to UPSERT, so `recursive_triggers` cannot misfire either.
- **IndexedDB:** the equivalent gap is tracked in [loro-dev/loro-repo#136](https://github.com/loro-dev/loro-repo/issues/136). It also covers concurrent tabs from different releases, and it gates Phase 1 on the web.

**Phase 3 as implemented (branch `feat/cli-sqlite-replica-checkpoints`, on loro-repo 0.21.0).**

- **Phase 2 was skipped.** #137 merged before Phase 2 started, and replica-bound persistence already awaits a real per-resource barrier before every cursor save. A separate Phase 2 would only have been rewritten.
- **Wiring.** `createCliStreamsTransport` now takes the repo and the LoroDoc cursor store and passes `createRepoStreamsPersistence(repo, { documentRemoteCursorStore })`.
  - `CliSqliteRepoStore.remoteCursorStore` becomes `documentRemoteCursorStore`. LoroDoc rooms keep the `AliasedRemoteCursorStore` URL-alias fallback.
  - Meta and Flock checkpoints are keyed by the exact URL, so a gateway flip costs those rooms one bootstrap.
- **Coalescer removed.** The schedule-only `onPersist*` callbacks, `PersistCoalescer` and the `remote-*` persist reasons are gone.
- **Measured barrier cost on SQLite** (WAL, `synchronous=NORMAL`, real disk, 5k meta docs, a 65 KB session doc, 300 remote batches; rows verified written):

  | Barrier          | p50     | p95     | max     |
  | ---------------- | ------- | ------- | ------- |
  | `persistMetaNow` | 0.03 ms | 0.17 ms | 20.7 ms |
  | `persistDocNow`  | 0.03 ms | 0.14 ms | 3.3 ms  |

  The coalescer's original cost reason, a 61 ms `repo.flush()` per event, does not apply to these per-resource journal/delta writes.

- **`tests/cli-streams-replica-checkpoints.test.ts`** drives the real CLI store and transport against a scripted Streams server:
  - **Stale one-shot replica.** A one-shot replica that hydrated before the daemon advanced the file bootstraps instead of resuming at the daemon's tail.
  - **Crash after a failed write.** When the data write fails and the process crashes, the checkpoint does not advance, and the restart bootstraps and recovers.
  - **Normal restart.** A restart resumes from the process's own durable checkpoint.
- **Ablations.** Each test fails under the variant it guards against:
  - with the shared-cursor two-argument factory, the stale replica ends without A;
  - with a schedule-only barrier, the sync reports success while the write failed;
  - with ephemeral cursors, every restart bootstraps.
- **Review fix (P1): LoroDoc cursors are daemon-only when shared.** loro-repo does not bind LoroDoc cursors to the doc bytes, so a one-shot command that opened a doc before the daemon advanced it would resume from the daemon's shared `remote_cursors` row and keep missing the daemon's data.
  - `LoroDocumentManager.create` now takes `documentCursorScope`. Only the daemon (`lib/lody.ts`) passes `shared-durable`; the default `process` keeps LoroDoc progress in memory, so one-shot commands bootstrap each doc they open once and never write shared cursors.
  - The shared cursors therefore only ever describe the daemon's own replica. Data written by one-shot commands can run ahead of them, which only replays.
  - Regression: a two-process `syncDoc` test (one-shot hydrates an empty doc, the daemon bootstraps A and advances the shared cursor, then the one-shot syncs and must receive A through a second bootstrap). With shared LoroDoc cursors the one-shot ends empty. The manager-create test asserts one-shot callers get an in-memory store by default.
  - A LoroDoc replica-bound checkpoint upstream would remove the per-command bootstrap; it is not required for correctness.
- **0.21.0 writes through `saveMany`.** The SQLite and IndexedDB adapters now expose the optional atomic `saveMany`, and loro-repo prefers it over `save` for metadata and named Flock payloads. The crash test therefore injects the disk-full failure into both entry points and asserts that `saveMany` exists. A wrapper that lists adapter methods explicitly (such as #1060's write observer) must forward `saveMany`: omitting it stays correct but silently falls back to one commit per payload, undoing #141.
- **Limit.** The first open after this upgrade writes the checkpoint table and triggers. If the disk is already full at that moment, the workspace fails to open (loro-dev/loro-repo#139).

## Alternatives

- **Upgrade and switch composition in one release.**
  - Rejected: a regression could not be attributed to either change.
  - Phase 0 gives a rollback point that touches no cursors.
- **Seed checkpoints from existing cursors to avoid bootstraps.**
  - Rejected: it moves possibly-unbound progress into a store that claims to be bound, making the new guarantee false for exactly the caches that need repair.
- **Keep the two-argument factory in the renderer.**
  - Rejected as the end state: it keeps ordering but not atomic recovery, so shared-database tabs remain unsafe.
- **Enforce single-writer access in the CLI with a file lock** instead of Phase 3.
  - A smaller option for mismatch 2 if the upstream work is delayed.
  - It blocks one-shot commands while the daemon runs, or forces them to route through the daemon. That is a product decision that has not been made.

## Outcome and verification limits

The proposal above is kept as written. This section records what shipped, and it replaces the proposal's desk-analysis limits.

- **Shipped.**
  - #1049 upgraded to loro-repo 0.20.3 and removed the patch.
  - #1058 bound the renderer's Meta/Flock cursors to the IndexedDB replica.
  - #1066 bound the CLI's cursors to the SQLite replica and upgraded to loro-repo 0.21.0.
  - Phase 2 was folded into #1066.
- **Upstream.** loro-repo 0.21.0 ships three changes:
  - the SQLite `replica_checkpoints` table with delete triggers (loro-dev/loro-repo#137);
  - the IndexedDB lineage marker (#138, which closes #136);
  - one strict transaction per flush through the optional atomic `saveMany` (#141, which closes #140).
- **Evidence.**
  - The Phase 0 simulations and the Phase 1 and Phase 3 regressions and ablations listed above.
  - Independent Reviewer passes found no remaining P0/P1 at each merged head.
  - The #1066 review ran 0.20.3 and 0.21.0 alternately against one fake-indexeddb database and one SQLite file. No data was lost, and no checkpoint moved past its data. The extra bootstrap cost is not bounded, though. Each time an older release rewrites a named Flock queue, it drops the lineage marker, so the next 0.21.0 open of that resource bootstraps again. For Meta, only an older release's destructive `meta-snapshot` has that effect. This repeats for as long as an older writer stays active (loro-dev/loro-repo#138, trade-offs).
  - With the page count capped until SQLite raised `SQLITE_FULL`, `saveMany` rolled back every row.
- **Open follow-ups.**
  - Opening the database for the first time after the upgrade still fails if the disk is full (loro-dev/loro-repo#139).
  - Storage-adapter wrappers must forward `saveMany`. #1060's write observer is being updated; omitting it stays correct but falls back to one commit per payload.
  - A replica-bound LoroDoc checkpoint upstream would remove the per-command LoroDoc bootstrap. It is not needed for correctness.
- **Limits.**
  - fake-indexeddb and real Chromium prove transaction ordering, not durability across power loss.
  - The strict-flush cost was measured on 0.20.3 (see the table above). #141's batching has not been re-measured inside Lody.
