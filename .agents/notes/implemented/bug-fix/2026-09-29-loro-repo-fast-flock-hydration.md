# Upgrade Loro Repo to hydrate stored Flock files on the fast path

Status: implemented
Translation: current

[中文](2026-09-29-loro-repo-fast-flock-hydration.zh.md)

PR: [LodyAI/Lody#1113](https://github.com/LodyAI/Lody/pull/1113)

## Abstract

On loro-repo 0.21.0 the renderer rebuilt the entire workspace metadata Flock each time IndexedDB compacted it. A Web profile from 2026-09-29 shows one `Flock.recoverFromFile` call of about 1.19 s, reached from `compactMetaSnapshot`, followed by about 500 ms of `exportFileV2Incremental`. Lody now pins loro-repo 0.21.1, which opens stored Flock files with `importFile` instead of permissive recovery. The file format was not the cause: every sampled frame is on the v2 (`FLK2`) path, and no v1 code ran.

## Decision and evidence

- **Cost breakdown.** Inside the recovery call, `recover_v2_raw_entries_from_bytes` decodes every entry (357 ms), and `rebuild_from_raw_import_entries` writes them all back through `apply_three_tree_write_set` (813 ms). `loadReplica` and `readFlockDoc` took the same path at 17 ms and 8 ms.
- **Cause.** [loro-dev/loro-repo#132](https://github.com/loro-dev/loro-repo/pull/132) (0.20.3) changed the shared `hydrateMetaSnapshots` helper from `Flock.fromFile`/`importFile` to `recoverFromFile`/`recoverImportFile`. It did this so that corrupt remote Streams bytes written into the update log would be dropped before being folded into a base. That helper also opens the locally written base snapshot, and `MetaPersister` triggers compaction periodically. As a result, every compaction and load decoded and rebuilt the whole store.
- **Fix.** [loro-dev/loro-repo#142](https://github.com/loro-dev/loro-repo/pull/142), released in 0.21.1, routes every stored Flock file through `importFile`. On a clean v2 file imported into an empty Flock, this checks the table CRCs and then adopts the file lazily in O(1). If a file is rejected, flock-wasm retries through `recoverImportFile` itself, so detected corruption still drops only the unreadable entries. The 0.21.0 → 0.21.1 package diff changes only `dist/flock-snapshot.*` and the version field, and the public declarations are unchanged.
- **Upstream measurements.** In upstream Node measurements with 100k entries (a 640 KB file), opening the base dropped from 530 ms to 2.6 ms, and the export after one local write dropped from 147 ms to 6.5 ms.
- **Lody changes.** The shared catalog pin, the exact release-age exception, and the package-scoped `@loro-dev/streams-crdt` peer allowance move from 0.21.0 to 0.21.1. The peer range is still `^0.15.0`. The lockfile changes only the loro-repo version, its integrity hash, and peer-qualified references. This continues the [loro-repo 0.21.0 persistence migration](../architecture/2026-09-27-loro-repo-flock-persistence-migration.md); replica-bound checkpoints and the other #132 persistence fixes are unchanged.

## Verification and limits

- The published tarballs were compared: `diff -r` shows only the Flock snapshot helper and `package.json` changed.
- The lockfile was regenerated with pnpm 10.20.0 via `pnpm install --lockfile-only`.
- The speedup has not been re-profiled in the Web app; the numbers above are upstream Node measurements.
- A base with valid table checksums but malformed records is no longer decoded eagerly, so those records are hidden on read, as they were before 0.20.3. Lody never writes such a base.
