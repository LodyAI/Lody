# Storage crisis: a full or dead repo IndexedDB

Why the renderer stops writing instead of retrying, and why recovery is a process
restart. Binding rules live in
[`packages/components/AGENTS.md`](../../packages/components/AGENTS.md); the decision and
its rejected alternatives are in
[the note](../notes/proposed/bug-fix/2026-09-06-storage-crisis-fail-closed.md).

The renderer's CRDT replica is `lody-loro-repo-db-<workspaceId>`, opened by
`create-workspace-runtime.ts` through loro-repo's `IndexedDBStorageAdaptor`. It is the
user's data, not a cache — which is what separates it from every other local store
listed at the bottom of this page.

## What the browser actually does when the disk fills

Two different errors, in this order, and only the second one is what users report:

1. A write is rejected with `QuotaExceededError`. Recoverable in principle.
2. Chromium tears down the backing store but keeps the `IDBDatabase` object alive.
   From here every `db.transaction()` throws
   `InvalidStateError: ... The database connection is closing.`

The second state does not heal inside the page. Freeing disk space does not reopen the
connection, and neither does `location.reload()`: the dying store is bound to the
renderer PROCESS. This is the whole reason the recovery action is `app.restartApp()`
(`app.relaunch()` + `app.quit()` in `app-ipc.ts`) rather than the reload that every
other crash surface offers.

## Why the breaker sits under the repo, not at a call site

`IndexedDBStorageAdaptor.loadDoc` opens its transaction `readwrite`, because it may
consolidate queued updates into a fresh snapshot. So opening a brand-new session room —
which writes nothing and returns `undefined` — still takes a readwrite transaction, and
throws on a dying connection:

```text
ChatLanding submit
  startSession → acquireSessionStore → repo.openPersistedDoc(roomId)
    IndexedDBStorageAdaptor.loadDoc          # readwrite, even for an empty room
      db.transaction(...)                    # bare; throws InvalidStateError
  catch → toast.error(t('chat.failed'), { description: err.message })
```

Session creation therefore breaks on the READ path, before any write is attempted, and
archive, send, and workspace-catalog writes hit the same dead connection immediately
after. A guard in `chat-landing.tsx` would have covered one of those callers.

`createCrisisAwareStorageAdapter` wraps the adaptor passed to `LoroRepo.create` instead.
Every classified failure is re-thrown as `StorageCrisisError`, so no caller can paste a
raw `IDBDatabase` string into a toast — including the first one, which is what made the
message look cryptic rather than merely repetitive.

## Fail closed, reads included

Once latched, no method reaches IndexedDB again. Reads reject rather than answering
`undefined`, because `undefined` is loro-repo's "this document does not exist": a
workspace would render empty and the next write would start a fresh history over the
one still on disk. `close()` is the single delegated method — it opens no transaction,
and runtime dispose depends on it.

The latch is one-way for the page lifetime and the FIRST failure wins, so the recovery
screen keeps naming the original cause rather than the last symptom.

## Classification

`classifyStorageFailure` walks the `cause` chain, because loro-repo's `createError()`
builds ``new Error(`${context}: ${cause.message}`, { cause })`` — it keeps the message
but drops `cause.name`, and the name is the reliable signal. Matching also falls back to
message text, which is a heuristic: DOMException prose is not stable API across engines
or locales. [loro-dev/loro-repo#129](https://github.com/loro-dev/loro-repo/pull/129) adds
a stable `code` that would make this exact; the note explains why it is not read yet.

Anything unclassified keeps its existing behavior. A transient or logic error must not
lock the app into a state whose only exit is a restart.

## Sibling stores that are NOT this

| Store                                               | Behavior on failure                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Repo replica `lody-loro-repo-db-*`                  | Fail closed. This page.                                                                                                              |
| Stream cursors `lody-loro-stream-cursors-*`         | Fails OPEN to memory (`resilient-remote-cursor-store.ts`) — cursors are replay checkpoints Streams can rebuild.                      |
| CLI replica (`~/.lody/loro-repo/<ws>/repo.sqlite3`) | Different process. Deleting it does not revive the renderer's connection, and loses data.                                            |
| `lib/clear-local-cache.ts`                          | Deletes databases on the NEXT boot, because `deleteDatabase()` blocks while the runtime holds a connection. Not an in-crisis action. |

Renderer IndexedDB lives in Chromium's `userData`, not under `getLodyDataDir()`, so
freeing space by removing worktrees or logs helps a later restart and cannot repair a
live connection.
