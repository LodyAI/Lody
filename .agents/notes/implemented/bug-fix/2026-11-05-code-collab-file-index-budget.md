# Bound the Code Collab file index and coalesce Flock local exports

Status: implemented
Translation: current

[中文](2026-11-05-code-collab-file-index-budget.zh.md)

## Abstract

A Nightly CLI kept its main thread at about 100% CPU and the local Supervisor
kept reconnecting. A Code Collab file-index rewrite had issued thousands of
individual Flock commits, and patched-in `@loro-dev/streams-crdt` queued one full
Wasm `exportJson` per commit even after the first export had covered everything.
The index itself had grown to an uncompressed 5.3 MB update: an in-project
`.pnpm-store` was not gitignored, All Changes had no budget, and paths the scan
budget truncated were published as `deleted`. The fix coalesces local exports per
subscription, filters package-manager caches, and bounds the whole published index
to 1,000 rows and 100 KiB of estimated Flock JSON. Truncated paths are now not
loaded rather than deleted. The trade-off is a shallower shared tree: rows past the
budget are loaded on demand through their lazy parent.

## Problem

Read-only diagnosis of an affected install (0.110.0-nightly.3) showed:

- 91.2% of sampled inclusive time was in the streams-crdt local drain, inside Flock
  `exportJson` (`try_version`, B-tree lookups). GC and idle time were 0%. A
  setTimeout queued during the burst only ran when the whole queue had drained.
  The health check recovered briefly and then stalled again on the next index write.
- One stored update was 5,294,234 bytes of JSON with 18,180 records. Of those,
  17,846 were under `.pnpm-store` (about 99% of the bytes). Among them were 11,229
  `kind: 'deleted'` business rows for files that existed but had fallen outside the
  10,000-entry scan budget. A later repair reported 21,229 paths: the budget
  limited only the tree, and `buildCodeCollabFileIndexState` appended every All
  Changes path without a limit.
- The writer looped `delete`/`set` and committed once at the end. Without a Flock
  transaction or debounce, every operation is delivered as its own local event, so
  the final commit coalesced nothing.

Replaying the copied data in a separate process with the shipped adapter gave these
single-machine diagnostic numbers (not guarantees):

| Condition                              | Writes | Exports | Empty exports | Total     |
| -------------------------------------- | -----: | ------: | ------------: | --------: |
| Saved snapshot, one event per write    |  4,000 |   4,000 |         3,999 |  1,260 ms |
| V1 storage, one event per write        |  4,000 |   4,000 |         3,999 | 15,016 ms |
| V1 storage, one coalesced event        | 17,846 |       1 |             0 |    384 ms |

The live process's JS heap was not read, so its storage format and exact queue
length are inferred, not observed.

## Decision

- **Export coalescing (dependency patch).** `patches/@loro-dev__streams-crdt@0.19.2.patch`
  changes `createFlockAdapter().subscribeLocalUpdates`. A subscription has at most
  one export pending. Before exporting, it yields one macrotask (`setTimeout`),
  because a Promise-only yield cannot let IPC or timers run. The pending flag clears
  just before the synchronous Wasm export, so a commit made during the export
  schedules exactly one more. The frontier advances only from bundles that were
  actually exported. A failed export leaves the range for the next commit, and
  unsubscribing stops delivery without advancing the frontier. This patch is
  temporary: remove it when an upstream streams-crdt release coalesces local
  exports, and port its test to that version.
- **Cache policy.** `.pnpm-store` joins `CODE_COLLAB_IGNORED_DIRECTORY_NAMES`, used by
  the watcher, the FS fallback, and the untracked half of Git listings. Git listing
  now lists tracked and untracked paths separately, so a tracked file under a
  policy directory stays visible. Untracked All Changes paths are filtered before
  any read, and only the first `CODE_COLLAB_FILE_INDEX_LIMITS.maxEntries` are read
  for line counts.
- **Project `.gitignore` everywhere.** Recursive Git listings already used
  `--exclude-standard`. But a filesystem scan still runs in a Git worktree for
  non-recursive directory refreshes (turn-end refresh scans changed directories
  this way) and whenever `git ls-files` fails, and it listed ignored outputs such as
  `coverage/` or `.env`. Filesystem scans now prune them while walking:
  `createGitIgnoreScanFilter` evaluates the rules in-process with the `ignore`
  package. The deepest `.gitignore` decides first (loaded lazily per directory),
  then its parents, `info/exclude` and `core.excludesFile`. An ignored entry is
  never classified, counted against the budget, or descended into. One
  `git ls-files --cached` call per directory that has ignored entries keeps entries
  that hold force-added tracked files. Outside a worktree, the scan root's
  `.gitignore` files still prune recursive scans, which is where an unpruned walk
  costs the most. Post-filtering with `git check-ignore` was rejected: it would
  still walk the ignored trees and let them consume the entry budget. Watcher dirt now
  carries the root-relative event path. A debounce window whose paths Git ignores
  entirely does not rescan. A path-less event, a non-`event` reason, or more than
  256 paths still rescans, and so does any failure of Git to answer.
- **Whole-state budget (owner decision, 2026-11-05).** `CODE_COLLAB_FILE_INDEX_LIMITS`
  is 1,000 rows and 102,400 estimated bytes for the complete publishable index. The
  estimate counts the escaped JSON key, the value, and a calibrated 113-byte
  clock/punctuation upper bound per row. Over budget, rows are kept in this order:
  root children, children of recently expanded directories, changed rows (with
  their ancestors), then breadth-first. Expanded directories are a per-owner
  in-memory MRU of 32. The scan budget drops to the same 1,000.
- **Deletion semantics.** Only a change recording `del: true` becomes `deleted`. Git
  binary deletions and diff-store missing files now record `del`. Any other changed
  path missing from the tree is an existing `file` row with `lazy` ancestors.
- **Diff invalidation metadata.** The [remote diff transport](../architecture/2026-10-31-remote-diff-transport.md)
  stores opaque generation siblings. Every changed path reserves a second physical row
  and the estimated JSON cost of a token up to 64 encoded bytes. The publisher renews
  larger tokens. Generation sets and orphan deletions share the file-row commit plan,
  so metadata cannot bypass either the whole-index or per-append budget.
- **Bounded commits.** The publisher plans the write as batches of at most 100 KiB
  each, with sets before deletes. After every batch it runs flush plus sync, which
  is the barrier that makes each batch its own Streams append. A failed batch goes
  to the existing owner repair loop, which re-plans from the replica.

## Alternatives

- **Budget each write at 100 KiB, cap the total at about 5,000 rows.** The owner
  rejected it: the shared state, and every first sync, would stay at megabyte scale.
  Splitting transport packets alone does not fix index growth.
- **Only add `.pnpm-store` to a repository `.gitignore`.** Code Collab serves
  arbitrary user projects, so the product needs its own cache policy.
- **Enable Flock debounce globally, or rely only on application batching.** Debounce
  changes commit semantics for other callers. Application batching cannot protect
  other Flock writers from the adapter's per-event exports.
- **Lower only `CODE_COLLAB_LIMITS.maxSupportedFiles`.** It is not on the file-index
  publication path, so lowering it would change nothing.

## Consequences

- The shared tree is shallower. A lazy directory loads on demand, and clicking it
  re-runs `init-directory` even when some of its children are already present. When
  the root alone has more children than fit the budget, there is no row that can
  mark the truncation; it is only logged.
- Clearing a legacy oversized index writes tombstones in bounded batches, one
  network sync per batch. The tombstones stay in Flock history for the stream's TTL.
- All Changes diff statistics still count untracked files beyond the read budget,
  but without line totals.
- A changed path whose old diff-store snapshot was `too_large` and which is now
  missing still lacks `del`, so it appears as a file.

## Verification

- `apps/cli/tests/streams-crdt-flock-local-export.test.ts` uses a real Flock to test
  coalescing, timer fairness, writes during a pending export, failure retry, and
  unsubscribe. It fails against the unpatched adapter.
- `apps/cli/src/lib/code-collab/file-index-scan-worker.test.ts` tests the cache
  policy versus tracked files, a 1,500-file untracked flood that stays within the
  budget without deletions, and the bounded line-count reads.
- `file-index-scan-worker.test.ts` also tests: `.gitignore` in non-recursive scans,
  including a force-added tracked file; nested rules, negation, `info/exclude`,
  directory-only patterns and subdirectory scan roots; and pruning of ignored
  directories from a recursive non-Git scan. `code-collab-v2-service.test.ts` tests that
  ignored-only watcher batches skip the rescan. `workspace-watch-coordinator.test.ts`
  tests the root-relative event paths.
- `apps/cli/src/lib/code-collab/code-collab-flock-publish.test.ts` replaces a 4,000-row
  legacy index of long, multi-byte, escaped paths in real Flock. Every exported
  commit stays at or under 102,400 bytes, and the result equals the bounded state.
- `packages/shared/tests/code-collab.test.ts` tests deletion semantics, priority
  order, and the byte budget.
- Not verified: packaged-Electron behaviour on the original machine, and remote
  convergence through a live Streams server.
