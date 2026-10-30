# Archive commits before its cleanup

Status: implemented
Translation: current
PR: [#1819](https://github.com/LodyAI/Lody/pull/1819)

[中文](2026-10-22-archive-commits-before-cleanup.zh.md)

## Abstract

Archiving a conversation in the desktop renderer used to wait for slow work before
the row disappeared or the view navigated. That work was two pending-input
cancellations, which include joining in-flight owner writes, and then a flush of
every dirty Repo document. Archive now commits its local `isArchived` writes first
and returns. Cancellation runs as an observed tail whose failure cannot undo the
archive. When that tail has joined in-flight creations, it archives any Tab they
created late. Persistence starts in the background instead of being awaited. Restore
blocks only on a cleanup this runtime has not confirmed, and refuses only while that
cleanup cannot complete. The local commit is the optimistic update, so no separate
UI overlay or rollback state exists.

## Findings

Each finding was traced through the real call chain. The trigger column names a
realistic event, not a hypothetical one.

| Finding                                      | Evidence                                                                                                                                                                                                                                | Trigger and impact                                                                                                                                   | Scope and recovery                                                                                                                                                                                                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normal slow path blocked archive             | `cancelWhere` in `session-accepted-inputs.ts` joins `running` drains and waits for the per-session Web Lock. A remote `requestSessionHistoryWrite` has a 30 s deadline and ignores the abort signal (`workspace-machine-rpc-facade.ts`) | An input is in flight to a slow or offline owner, in this window or another. The row stayed visible and navigation waited for up to the RPC deadline | Only the archived conversation was blocked. Before: it recovered when the RPC settled. Now: archive does not wait                                                                                                                                         |
| Auxiliary cleanup blocked the business write | `isArchived` was written only after both cancellations resolved. `cancelWhere` does IndexedDB `list`, `patch` and `remove`                                                                                                              | The input-storage IndexedDB is closed or over quota. Archive rejected and nothing was archived, even though archive state lives in the Loro Repo     | Every archive failed while storage failed; the next call recovered once storage did. Now the archive stands, the failure is recorded in `client-log`, and restore completes the cancellation                                                              |
| Whole-Repo flush on the archive path         | `repo.flush()` drains every dirty session doc, Flock doc and meta, and loops while new work arrives. It was added with `sendJournal.refresh()` (#1104), which has since been removed                                                    | Another conversation is streaming. Navigation waited for unrelated persistence                                                                       | No longer awaited. Sync reads the committed meta Flock directly, but local meta persistence otherwise waits for its 5 s default debounce and nothing flushes on unload. Archive therefore starts `repo.flush()` in the background and records its failure |
| Rejections dropped at two entry points       | `void onArchive()` (header and mobile menu) and `void archiveSession()` (mobile swipe)                                                                                                                                                  | Any archive failure, such as metadata still loading                                                                                                  | The user saw nothing and the rejection went unhandled. These entry points now show the toast the sidebar already shows                                                                                                                                    |

## Why reordering is safe

- **Held sends.** `cancelSessions` aborts this window's held work and marks it
  canceled synchronously, before the archive writes. The held layer re-checks
  the abort before writing (`session-pending-sends.ts`).
- **Durable Roost inputs.** `validateTarget` refuses an archived target before
  every owner write, lookup and delivery. This covers inputs from other windows too.
- **Activation.** `activateUserTurn` skips archived sessions. The CLI dispatch
  watcher no-ops on archived meta (`session-dispatch-logic.ts`).
- **Remaining case.** A write already past its last abort check can still commit,
  exactly as with the old join-first order. Only its timing relative to the archive
  flag changes, and an archived session never starts work.
- **Late Tabs.** The old order scanned targets after the join, so a Tab whose
  creation committed during the join was included. The tail now restores that
  outcome. After the join it re-reads targets with the same operation (`archive`, or
  `archive-tree` when the user chose to include opened Sessions) and archives Tabs absent from the
  original scan. It runs only when a held creation under those targets existed,
  and only while the root is still archived, the workspace is still active and no
  restore of the root has started. Restore bumps a per-root generation before its
  first await, so a restore whose target read missed the late Tab also stops the
  repair. Late Tabs go through the same write as the others, including closing
  their terminal sessions.

A new conversation joins its cancellation only while its metadata is still
unwritten, because then the in-flight write decides whether there is anything to
archive. Once the metadata exists, its first owner write (up to the 30 s RPC
deadline) is the ordinary tail. Archive no longer waits for it.

## Cleanup responsibility

A failed tail leaves stored input without its `canceled` mark. This window still
skips it, because the in-memory `canceled` set covers it. But after a reload, or
in another window, `resume` delivers it once the session is no longer archived.
Un-archiving is therefore the only step that can make leftover input deliverable.
Each archived Session records its cleanup in the runtime until the cleanup confirms.
`restoreSession` consults only those records:

- still running: it waits for that cleanup. This is normally milliseconds, and at
  most the in-flight RPC deadline when a restore follows an archive of a
  conversation whose owner write is still outstanding;
- failed: it retries `cancelSessions`. While storage still fails, restore rejects
  with the original error and changes nothing; the next restore after recovery
  succeeds. The refusal is an `ArchivedInputCleanupPendingError` that keeps
  the storage error as `cause`; every restore entry point, including bulk restore
  on the archive page, shows a localized "try again shortly" message instead of
  the generic failure.

Restores with no record, such as earlier archives or archives whose cleanup
confirmed, never touch input storage, so a storage fault does not block them.

If writing the durable cancellation mark fails, the drain must skip inputs in
this window's `canceled` set without counting that skip as progress. Otherwise it
re-lists the same row forever while holding the session lease, preventing the next
cancellation from finishing even after storage recovers. The drain releases its
lease; a later cancellation still owns marking and removing the retained row.
The fix retains the existing native send-resource scope and Promise ports rather
than migrating the whole input coordinator for this local progress condition.

The records live in memory. After a reload, or in another window, a failed cleanup
is unknown, and leftover stored input meets `validateTarget` while archived:
`queued` rows become `failed` and wait for an explicit retry, and `unknown` rows
keep converging by lookup as designed. This residual risk is accepted rather than
gating every restore on input storage.

The cleanup handler attaches when the promise is created, so a fast rejection
during the archive writes is never an unhandled rejection. Workspace teardown or a
switch is logged at `info`.

## Verification

`tests/use-session-actions.test.ts` covers the real held-send queue:

- archive resolves while an upload that ignores abort is still being joined;
- a Tab whose creation commits after the scan is archived by the tail;
- a new conversation whose metadata exists archives while its first write is
  blocked, and the landed turn is never activated;
- a restore that starts before a late Tab commits leaves that Tab unarchived
  under the restored root;
- a stalled `flush` plus a rejecting cancellation still leave the archive in
  place; restore refuses while the cancellation fails, keeps the session
  archived, and after the fault clears drops the surviving input before
  un-archiving; a later restore whose cleanup confirmed is not blocked by a
  storage fault.

`tests/session-accepted-inputs.test.ts` also exercises real IndexedDB storage
through `fake-indexeddb`: a failed cancellation mark keeps the input fenced,
the drain releases an exclusive session lease, and the next cancellation removes
the retained row after recovery. A second runtime resuming a stored input for an
archived conversation persists a refusal without appending history or delivering it.
The two focused suites pass together (118 tests).

The held-queue assertions were checked against the previous implementation or
with their specific guard removed. The disposable Electron probe only completed
partial idle measurements: four closed rows disappeared in 27–44 ms; three open
conversations disappeared in 51–68 ms and navigated in 77–115 ms. The browser closed
before the streaming cases finished. No baseline comparison or streaming latency
conclusion is available; the probe scripts remain outside the PR.
