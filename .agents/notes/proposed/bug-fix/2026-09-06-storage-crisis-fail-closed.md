# Fail closed on a full or dead repo IndexedDB

Status: proposed
Translation: current

English | [中文](2026-09-06-storage-crisis-fail-closed.zh.md)

## Abstract

When a user's disk filled, the renderer's CRDT replica hit `QuotaExceededError` and then
a permanently closing IndexedDB connection, so every attempt to create a session failed
with a raw Chromium DOMException in a toast, and the toasts kept coming after the user
freed space because only a process restart reopens that connection. We classify the
failure inside a wrapper around the storage adapter passed to `LoroRepo.create`, latch a
one-way breaker, and replace the repeating toasts with one blocking screen whose action
relaunches the app. Reads fail closed alongside writes, which is the load-bearing
choice: returning `undefined` would read as "this document does not exist" and let the
next write start a fresh history over durable data. The classifier still matches
DOMException message text as a fallback, which is a heuristic rather than a stable
contract; removing that depends on upstream work not yet done.

## Problem

Reported as [Lody #417](https://github.com/LodyAI/Lody/issues/417). Creating a session
showed `会话创建失败` with a body of
`Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.`,
and every retry stacked another one. Nothing in the app could succeed, and nothing in
the app said so.

Two findings shaped the fix. First, `IndexedDBStorageAdaptor.loadDoc` opens a
`readwrite` transaction even for a brand-new room that writes nothing, so session
creation breaks on the READ path, before any write — a guard in the composer would have
covered one caller out of many. Second, the dying connection is bound to the renderer
process, so freeing disk space and reloading both fail to recover it.

## Decisions and findings

Shipped in [LodyAI/Lody#438](https://github.com/LodyAI/Lody/pull/438), Phase 1 of the
issue; the filesystem-only **Manage storage** panel it describes as Phase 2 is not built,
so the issue stays open.

The breaker lives under the repo, in `createCrisisAwareStorageAdapter`, not at the call
sites: archive, send, and workspace-catalog writes hit the same dead connection as
session creation. It re-throws every classified failure as `StorageCrisisError`, so raw
engine text cannot reach a toast even on the first failure. The mechanism is explained
in [storage crisis](../../../docs/components-storage-crisis.md).

We verified that loro-repo does not lose data when a save fails: `persistDocUpdate`
rolls `docPersistedVersions` back and re-queues the document, and `MetaPersister`
advances `lastPersistedVersion` only after `save()` resolves. So this is a UX and
correctness-of-failure problem, not a durability bug.

It is, however, a durability WINDOW: nothing re-triggers a flush after a failure, so the
re-queued document waits for the next doc event and the meta Flock for its next
subscription callback. A transient failure therefore leaves the last change unpersisted
until the user happens to edit again — filed upstream as
[loro-dev/loro-repo#130](https://github.com/loro-dev/loro-repo/issues/130), which is
orthogonal to a full disk (where nothing can be persisted anyway) and out of scope here.

### Alternatives considered

**An in-memory repo fallback**, mirroring `ResilientRemoteCursorStore`. Rejected: that
store degrades safely because Streams cursors are replay checkpoints the server can
rebuild. Repo documents are the user's data, so a memory stand-in would accept writes it
can never persist and lose them on the restart it cannot avoid.

**Reads returning `undefined` while writes fail.** Rejected for the reason in the
abstract; it converts a visible failure into silent data loss.

**Auto-reopen on `InvalidStateError`** (`db.close()`, clear the cached promise, retry
once), listed as optional in the issue. Rejected: on a full disk the reopen fails too,
and a self-healing storage layer makes it harder for the app to fail closed. Sticky
classification plus an explicit restart is the clearer contract.

Reinforced afterwards: `ensureDb` caches the promise from a FAILED open and never clears
it, unlike the `close()` and `versionchange` paths, so the adaptor instance is already
dead for the page lifetime once opening fails
([loro-dev/loro-repo#131](https://github.com/loro-dev/loro-repo/issues/131)). An
app-level reopen would have been building on a layer that cannot reopen itself.

**Patching `patches/loro-repo.patch`** to classify inside the library, which the issue
suggested for speed. Rejected: `StorageAdapter` is a public interface and every method
is `async`, so a bare synchronous `db.transaction()` throw already surfaces as a
rejection the wrapper sees. Patching the published `dist/` (two builds) would have to be
re-applied on every version bump for no user-visible gain.

### Known limit

`classifyStorageFailure` matches DOMException `name` first but falls back to message
regexes, and that prose is not stable API across engines or locales. A differently worded
engine message is treated as unclassified, which fails safe: the app keeps its previous
behavior rather than latching wrongly.

[loro-dev/loro-repo#129](https://github.com/loro-dev/loro-repo/pull/129) is the upstream
fix — a `RepoStorageError` carrying `code: 'quota' | 'unavailable' | 'unknown'`, and
`loadDoc` no longer needing `readwrite`. We deliberately did NOT pre-write `code` support
here: the contract is open for review upstream and could be renamed, and a field name that
never matches would be dead code hiding behind working heuristics. Read `code` first when
Lody next bumps loro-repo, with a test that can actually exercise it.

That PR renames the thrown error to `RepoStorageError` while preserving message text and
the `cause` chain. Verified safe for this classifier, which never compares against
`'Error'` and walks `cause` regardless.

Upstream also confirmed the `readwrite` in `loadDoc` was deliberate, not an oversight:
splitting the read and the `delete(docId)` into two transactions would drop updates
appended in between. The fix generalizes the existing compare-then-write helper instead of
separating them naively.

## Verification

3216 component tests across 438 files (27 new, covering classification, cause-chain
walking, a cyclic chain terminating, fail-closed reads, optional adapter methods not being
advertised when the inner adaptor lacks them, and the recovery screen's actions), 91
Electron tests, 27 script tests, typecheck, lint, i18n, `pnpm run docs check`, and the
public/platform/code-collab boundary guards. Counts are from the branch merged with `main`
at 90c6eaf2.

The disk-full condition itself was reproduced from fixtures rather than a real full volume;
no manual end-to-end run on an exhausted disk was performed. Toasts raised after the
recovery screen mounts are not dismissed — they render beneath it and carry the controlled
message, not engine text — so the screen suppresses the reported symptom rather than every
possible toast.
