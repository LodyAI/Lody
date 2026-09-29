# Remove the session send journal

Status: implemented
Translation: current

[中文](2026-09-29-remove-session-send-journal.zh.md)

## Abstract

The renderer kept every accepted message in a crash-durable IndexedDB journal
until the target had it. Durability reached the send path, archive, delete,
logout, cache clearing, every window and Electron quit, and each fix exposed
another edge. The journal is removed. A ready message becomes local commits on
the live document, followed by a best-effort dispatch or steer request. The CLI
already starts pending turns from synchronized history. A message whose
attachments are still preparing waits only in renderer memory, in order per
conversation, and is written once every attachment is ready. The accepted cost:
if the page closes, crashes, reloads or switches workspace during that upload,
the message is lost. A leave confirmation is the only protection.

## Problem

The journal (`lody-session-send-v1`, record versions 1–4, stages
`saved → prepared → committed → delivered`) came from #719 (commits
`cf5c925b..c5a07dd0`). Later fixes were `5aa38149`, `39e74acb`, `a4dfbf6f`,
`21993521` (#1079), `e89ab564` (#1091), `1e805cf7` (#1095) and `e7e7ae1b`
(#1104). Making the input survive a crash forced these mechanisms:

- persisting source Blobs;
- cross-window Web Locks and BroadcastChannel interrupts;
- merging the original window's replica before reconciling identity;
- guide-offer bookkeeping so an uncertain steer was never replayed;
- a projection overlay so text-only sends did not flash as pending;
- gating logout, cache clearing, reload and workspace switches;
- a quit/close/reload handshake between Electron main and the renderer.

Each of these had its own failure modes (#1104 alone reworked archive and exit
blocking). The durable part protected one narrow window: the time between Send
and the end of the attachment upload.

## Decision

Remove the crash-durable journal. Keep attachments that are still preparing in
memory. Accept that closing the page during an upload loses the message.

- **Ready sends** (`lib/session-send-delivery.ts`, `session-send-admission.ts`,
  `session-submission.ts`): `writeUserTurn` runs through WorkspaceWriter and
  SessionData, as local commits. It first writes creation metadata (absent keys
  only). It then writes the turn (`appendSessionTurn`), or the queue row
  (`enqueueSessionMessage`, which bumps `messageQueueUpdatedAt`). For dispatch it
  also writes `latestUserMsgId`, which never moves behind a newer local user turn
  and is skipped for archived or deleted conversations. It ends with
  `repo.flush()`. A dispatch RPC then runs as a fast path; its failure is only
  logged. If the pointer write fails after the RPC was accepted, the send still
  succeeds. There is no retry loop and no wait for target synchronization.
- **Guide / steer**: the turn is written locally as `pending_apply`, then offered.
  - `applied` → `processing` with delivered-steer provenance.
  - `no-active-turn` or `promotion-failed` without `recoveryOwned` → the turn
    becomes `pending`, is activated and dispatched.
  - `recoveryOwned` → nothing; the daemon owns the turn.
  - An uncertain answer (`delivery-unknown`, timeout, transport error) leaves
    the turn as written. It is never replayed and is not shown as a send failure.
  - When the request provably cannot leave (cloud-routed target while the browser
    is offline, `isMachineRpcUnreachable`), the turn becomes `pending` and is
    activated.
  - Native queue steer returns to its order from before the journal: write
    `pending_apply` history with the queue item's `userTurnId`, remove the queue
    row, then steer.
- **Held sends** (`lib/session-pending-sends.ts`,
  `providers/workspace-pending-sends.ts`): a send with an unready attachment is
  held per workspace runtime. It reuses the existing attachment preparation,
  resources and multipart cancellation. Nothing reaches the CRDT until every
  attachment is ready. A failure keeps the send with an error, and retry and
  cancel are offered. Each conversation is FIFO: later history, queue or guide
  sends wait behind an earlier held one, and a failed head blocks them until it
  is retried or canceled. Canceling a held first message hands its creation
  metadata to the next held send.
- **Presentation**: a held new conversation appears through
  `pendingSendSessionMetasAtom`. Held sends render as the inline pending row, or
  as local queue-sheet rows when queue-bound. The sidebar mark comes from the
  same memory store (`components/chat/session-pending-sends-host.tsx`).
- **Leaving**: while held sends exist, the page installs `beforeunload`. In
  Electron, `apps/electron/src/main/renderer-unload.ts` turns any renderer veto
  into one native Stay/Leave confirmation for close, reload and quit. Quit
  closes each product window with unload approval before it stops relays or the
  CLI; Stay cancels quit with everything running. A window whose renderer hangs
  or dies during that close is destroyed, so quit never waits on it. The same confirmation now
  covers the code-collab unsaved-editor guard.
- **Archive/delete** never refuse because of pending messages. They cancel the
  held sends of their targets, including held child creations whose
  `parentSessionId` is a target. They also join any in-flight write, so a
  canceled send never writes afterwards. Archiving a conversation that exists
  only as a held creation just cancels it.
- **Logout, cache clearing, reload and workspace switching** are no longer gated.
  Cache clearing deletes `lody-session-send-v1`. Forced-clear flags written by
  older builds are still read.

## Responsibilities

| Concern                             | Owner                                                          |
| ----------------------------------- | -------------------------------------------------------------- |
| Local accept boundary               | `writeUserTurn` over WorkspaceWriter / SessionData             |
| Execution of pending user turns     | CLI dispatch watcher, from synchronized history and meta       |
| RPC dispatch/steer                  | Best-effort acceleration (`dispatchUserTurn`, `steerUserTurn`) |
| Sends waiting for attachments       | Runtime `pendingSends`, memory only                            |
| Upload, cancellation, store borrows | Existing workspace `sendResources` (Effect)                    |
| Leave protection                    | `beforeunload` in the page; native confirm in Electron main    |

## Evidence

The CLI dispatches from synchronized data (`apps/cli/src/session/session-dispatch-logic.ts`):

- `shouldWatchSession` watches the meta activation signals `latestUserMsgId`,
  `hasPendingUserTurnActivation` and `messageQueueUpdatedAt`.
- `findNextDispatchableUserTurn` dispatches `pending`/`seen` user turns with no
  RPC. Archived sessions are skipped.
- A `pending_apply` guide turn is dispatched only when
  `steerTurnStatuses[id] === 'pending'` or `latestUserMsgId` points at it.

A locally written turn plus its pointer is therefore enough for execution once
the document synchronizes. The journal's `delivered` stage protected an outcome
the daemon already reaches without it. Two fixes that do not depend on the
journal stay: the #1079 force-flush in `LocalLoroTransportAdapter.syncDoc`, and
the #1091 predicate `isSessionHistoryStatusAwaitingStart`, where `seen` still
awaits start.

## Alternatives

- **Keep the journal and outbox, and keep fixing edges.** Rejected: every
  surface that can end a page had to know about it, and the fixes kept moving
  the boundary.
- **An IndexedDB outbox only for attachment sends.** Rejected: it keeps Blob
  persistence, cross-window ownership and recovery UI, the main sources of
  complexity, to protect only interrupted uploads.
- **In-memory held sends only.** Chosen. Ready sends need no durability beyond
  the CRDT, and an interrupted upload is visible to the user before they leave.

## Trade-offs

The chosen design loses a held send if its page closes, crashes or reloads, or
if its workspace runtime is disposed (for example, a workspace switch). On
desktop, closing, reloading and quitting show a confirmation first. A workspace
switch disposes the runtime and cancels held uploads without asking. The
post-upload billing eligibility re-check that lived in the journal is gone; the
composer still checks eligibility at send time. There is no automatic retry of a
failed dispatch RPC; the CLI watcher picks the turn up from synchronized history.

## Legacy migration

`lib/legacy-session-send-migration.ts` runs once per runtime after the first meta
sync, under `navigator.locks`. It reads only the current account and workspace:

- A leftover record whose turn is absent is written as an ordinary local send.
  Version-2 `committed` rows are never appended again, because a fresh replica
  may simply not have synchronized them yet.
- Dispatch records and never-offered guides are activated and dispatched on a
  best-effort basis. Guides with `guideOffer: 'offered'` are left untouched.
- A record with an unprepared attachment is dropped with `console.warn`.
- Handled rows are deleted. Failed rows are retried at the next start. The
  database is deleted once it is empty.

Delete the migration, and the forced-clear flag reading, a few releases after
this change ships.

## Verification

Behavioral suites under `packages/components/tests/` cover this change, including
`legacy-session-send-migration.test.ts`, `session-pending-sends-host.test.tsx`,
`use-session-actions.test.ts`, `session-attachment-preparation.test.ts`,
`session-pending-message-row.test.tsx`, `clear-local-cache.test.ts`,
`runtime-provider.test.tsx` and `warm-window-lifecycle.test.ts`. The journal,
recovery and projection suites were deleted with their code. Commands and
results: see PR.

## Limits

- A held send is lost if the page closes, crashes or reloads, or the workspace
  runtime is disposed, before its attachments finish. Browsers may not show the
  `beforeunload` prompt (notably on mobile), and a workspace switch does not ask.
- No packaged-device or native-mobile acceptance was run.
- The legacy migration can only replay what older builds stored. Records with
  unfinished uploads are dropped.

Supersedes [local-first session sending](2026-09-29-local-first-session-send.md),
the journal parts of the [deferred attachment design](../architecture/2026-09-14-deferred-attachment-send.md)
and the [daemon-owned guide outcome](../bug-fix/2026-09-28-daemon-owned-guide-outcome.md).
Partially supersedes [local queue rows](../feature/2026-09-28-local-queue-pending-rows.md)
and [sidebar send status](../feature/2026-09-28-sidebar-send-status.md). Spec:
[Session files](../../../../specs/session-files.md).
