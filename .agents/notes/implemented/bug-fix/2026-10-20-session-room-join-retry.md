# Session rooms re-join after every initial join attempt failed

Status: implemented
Type: bug-fix
Translation: current
PR: [#1760](https://github.com/LodyAI/Lody/pull/1760)

[中文](2026-10-20-session-room-join-retry.zh.md)

## Abstract

An open conversation whose Session room could not attach in its first three join
attempts, which together take about three seconds, never tried again while it stayed open. The view kept its
cached copy until a reload. Loro Repo tears down a room record whose every
transport attach failed, so neither `repo.reconnect()` nor the workspace reconnect
loop had anything to repair. The Session store now schedules a fresh join on the
shared 1–30 s reconnect backoff while a sync lease still holds the room. The room
sync tracker also adopts a new subscription's current status, which the retry
needs to report `synced`. A separate, more likely cause of "stops updating until
reload" — a live read whose apply chain stalls while the room stays `joined` — is
analysed below but not fixed here; instead the conversation now records one
bounded `session.doc_stale` diagnostic when its history keeps ending in a turn that
live presence says is no longer running.

## Cause

`startSync` in `create-workspace-runtime.ts` runs `waitForRoomToSync`, which retries
`joinRoom()` only while it throws: at 0, +1 s and +2 s. That is not a deadline: once
`joinRoom()` returns a subscription, the first sync is awaited without a timeout, and
a later rejection leaves the subscription alive to self-heal. When all three attempts throw,
Loro Repo 0.23.3 `joinRoom` has already released the room
(`releaseRoomRef` → `teardownRoom`). The store recorded `markFirstSyncFailed()` and
cleared its join promise. Nothing called `startSync` again, because `acquireSync`
runs once per mounted view (`use-session-doc.ts`). The tracker reported `error`, so
the reconnect loop ran `repo.reconnect()` on its backoff, but that only repairs rooms
that still exist.

How often this is reached is limited. Network and authentication failures do not
make `joinRoom()` throw: both the Streams and the local data-plane adapters connect
without I/O and return a subscription synchronously from `joinDocRoom`, which then
heals inside the SDK, and an open Session store's doc is already loaded, so
`ensureDoc` hits its cache. The known throw sources are synchronous adapter join
errors and storage failures while loading. This retry is therefore a defensive fix,
not the cause of the commonly reported "stops updating until reload".

## Decision

- After a join pass fails without producing a subscription, and a lease remains,
  the store re-joins after `computeLocalReconnectDelayMs(attempt)`. A successful join
  resets the attempt count. Releasing the last lease or disposing the store cancels
  the timer; a timer that fires after the last release does nothing, so the pending
  room release keeps ownership.
- A caller that asks for sync during the backoff (a new lease, or `waitUntilSynced`
  from a send, its sending indicator or the completion notifier) cancels the timer
  and joins at once, keeping the attempt count. Otherwise that wait resolved with no
  join at all, clearing a message's sending state while nothing was uploaded, and
  recovery after the fault cleared waited up to 30 s. Concurrent callers still share
  one join pass.
- `createRoomSyncTracker().attach` now applies `sub.status` immediately. A Loro Repo
  binding emits its status when its base attaches, before `joinRoom()` resolves and
  hands it to the tracker. Without this, the `error` written by the failed pass
  outlived the subscription that replaced it.

The alternative was to make the workspace reconnect loop re-run Session joins. It
has no handle on store-owned join state, and every pass already releases idle stores
and resets backoff for other rooms. A store-local timer keeps the retry scoped to
the one room and to the lifetime of its lease.

## Verification

Three cases in `create-workspace-runtime-meta-recovery.test.ts` use a real `LoroRepo`
whose local adapter throws from `joinDocRoom`. The first fails four joins, then
asserts the store reaches `synced` and resolves `firstSynced`; it failed before both
changes (no retry, then a stale `error`). The second fails three joins, then asserts
that a `waitUntilSynced` call joins within 100 ms, well inside the shortest backoff,
and that the cancelled timer adds no later join; it fails when the timer blocks
callers. The third asserts that releasing the lease
stops further joins. The affected component suites pass.

## Not addressed: a live read that stops applying while it stays joined

The reported incident looked different: a conversation synced, then stopped
updating. Sends queued because the stale history ended in an unfinished assistant
turn (`unfinished_assistant_turn` route), and the info bar showed nothing. Reading
streams-crdt 0.19.1 shows a path that matches all three, not yet reproduced:

- Each SSE batch resets the 45 s inactivity watchdog before it is applied, and is
  applied on the room's single `opQueue` (`enqueueExclusive`). The apply imports the
  updates, then saves the cursor behind Loro Repo's durability barrier
  (`persistDocNow` → the Repo-wide DocManager queue → one IndexedDB transaction).
  None of these steps has a deadline.
- If one hangs, later batches and local uploads (`flushPendingLocal`) wait behind
  it while arriving events keep the watchdog quiet. The room stays `ok`/`joined`,
  the tracker reports `synced`, and "caught up" is sticky per open, so no indicator
  appears. A reload rebuilds the stack and bootstraps from the server.
- A server stream that sends only keepalives would look the same from the client.

A proper fix (deadlines on the apply chain, and progress-based rather than
arrival-based inactivity) belongs in loro-streams and Loro Repo.

## Stall diagnostic

Before this change nothing recorded such an episode. Loro Repo bindings hide the
SDK's `pendingLocalCount`; the persisted client log (sent with bug reports, full
for machine-backed reports and as a tail otherwise) held only explicit
`recordClientLog` calls; a reload discarded console `info` lines and the SSE
frames. On desktop, renderer `warn`/`error` console lines do reach the CLI daily
log through Electron main.

`useSessionDocStaleReport` (mounted by the conversation) fires when the doc is
ready, the owning machine has a fresh heartbeat, presence reports no work, and the
history still ends in an unfinished assistant turn for 30 s. Unknown or offline
machines are excluded, because a dead agent also leaves an unfinished turn. It
records once per turn per mounted conversation, as a `warn` client-log entry and
console warning, with ids, states and durations only:

- `bindingStatus`, `syncState` and `transportId` of the readiness binding;
- `lastRemoteImportAgoMs` from a per-store import timestamp (`null` means no remote
  import since the store opened) against `lastMessageAgoMs` from Session meta, which
  arrives over the separate Meta stream;
- `pendingUploadProbe`: one `waitFor({ phase: 'pending-upload-empty' })` bounded to
  10 s. In streams-crdt 0.19.1 it flushes local exports, then only waits for this
  replica's queued uploads to drain; it does not enter the room's `opQueue`. It is
  `complete` at once when nothing is pending, so it never proves that inbound applies
  flow. `timeout` means local changes stayed unsent for 10 s: a wedged queue, or just a
  slow upload.

Reading the entry: the main signal is a `joined` binding whose remote import is old
while the meta message is recent — a per-room stall in which the room claims health
but stopped applying. A `timeout` probe adds that this replica's uploads are stuck
too, consistent with a wedged room queue. A non-`joined` binding is ordinary
transport trouble. Other conversations in the same
workspace stopping too points at the Repo-wide persistence queue. A false positive
is a turn whose agent died while its machine stayed online: it costs one entry per
turn. Neither test exercises a real stalled SDK; they cover the trigger conditions,
the recorded fields and the probe against a never-settling `waitUntilSynced`.
