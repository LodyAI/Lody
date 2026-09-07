# apps/cli/src/lib/loro — Loro repo/runtime layer

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

## Mirrors over synced docs tolerate unknown root keys

Every `new Mirror(...)` over a doc that syncs between clients must pass
`ignoreUnknownProperties: true`. Peers on a newer schema write root keys this
build does not declare; without the flag loro-mirror rejects the entire state
with `Unknown property: <key>`, so the older client can never write to that doc
again. Contract test: `packages/shared/tests/session-doc-forward-compat.test.ts`.

## Opening a doc pulls its stream

`LoroDocumentManager.getOrCreateSessionDoc()` is not a cheap read.
`SessionDocument.init()` (`doc.ts`) calls `startDocRoomSync()` immediately: opening
a doc joins its room and starts pulling the stream, and the doc stays in the
manager's `sessions` cache with the room joined until `cleanSessionDoc` tears it
down. Cost per call = one Streams subscription plus the doc's full initial sync.

Rules:

- Renderer metadata reaches the CLI by direct import into the repo's internal
  meta Flock even when local mode has no registered transport. Keep the
  `loro-repo` metadata live monitor enabled from repo initialization; deferring
  it until transport join leaves `getDocMeta` stale and prevents the session
  dispatch watcher from seeing `latestUserMsgId`.
- Never open docs in a loop over `listAliveRoomIds` or any other workspace-wide
  enumeration. A long-lived workspace holds thousands of historical session
  rooms; opening them all stalls startup and floods the Streams backend.
- Bulk/startup/recovery scans must first filter to candidates through indexes
  that do not join rooms: `repo.getDocMeta(roomId)` meta records, the `e/`
  existence index (`lib/loro/repo-existence.ts`), or a purpose-built local index
  (example: `session/session-fork-operation-store.ts`). Open docs only for the
  filtered candidates, under a concurrency bound (`mapWithConcurrency`, 4).
- To drop a doc you opened for inspection, first prove no other holder adopted
  it: `LoroDocumentManager.sessions` is a shared cache with **no refcounting**,
  and `cleanSessionDoc`/`destroy` disposes the mirror out from under every other
  subscriber (the dispatch watcher, for one, unsubscribes before it cleans and
  its `watchedSessions` guard would block a re-subscribe — a destroyed shared
  instance silently kills doc-level signals for that session). When you cannot
  prove sole ownership, leave the doc cached. Never call
  `repo.unloadDoc`/`unloadDocRoom` on a live wrapper directly either (the room
  binding would leak; see `SessionDocument.destroy` in `doc.ts`), and never let
  teardown write status/meta for docs that must stay hidden (e.g. unfinished
  fork targets).

The dispatch watcher's contract, "session metadata is the activation index", is
documented in `../../session/AGENTS.md` and applies to any module enumerating rooms.

## Shared ACP runtime config contains no secrets

`SessionDocument.applyAcpRuntimeConfigPatch` is the durable boundary for the
workspace-shared runtime baseline. It must remove every option id matched by
`isSensitiveAcpConfigOptionId`, even when an upstream caller already filtered the
ACP response; otherwise a future agent can persist and broadcast credential-like
selector values to collaborators.

## Presence is ephemeral and partitioned by origin

`presence.ts`: machine presence refreshes on `CliPresenceRuntime`'s own 30s timer.
It keeps TWO stores and the distinction is load-bearing: `store` is the workspace-wide
replica (own writes plus every peer seen in the shared room; read by machine-online
checks and the PR poller), while `localOriginStore` holds ONLY entries this process
authored and is the sole payload of the local data plane (`encodeLocalOriginPresence` /
`subscribeLocalOriginPresence`). Write locally-authored presence exclusively through
`writeLocalOrigin`/`deleteLocalOrigin`, and never relay the replica —
`specs/local-first-two-plane.md` explains the partition.

`session-active-presence.ts` alone owns session active presence: it starts once for a
visible CLI turn, accepts phase updates, heartbeats while active, and clears on the
owning Effect release. Never publish or clear session presence from `setStatus`, RPC
dispatch, permission/image callbacks, or watcher recovery paths. Its scope covers ALL
turn-finalization stages, so optional cloud side effects inside it (usage flush,
completion notification, Live Activity sync) MUST go through
`MessageHandler.runTurnCloudSideEffect`; third-party calls (GitHub, model APIs) are a
different reachability domain and are NOT gated by it.

Never reintroduce periodic doc-meta writes (`lastSeen`/`lastRunningSeen`) — they stall
Loro flush; meta timestamps are written only at status transitions. Durable
`MachineMeta.lastSeen` is retired (not written even at registration); machine online
checks read presence only, and `getOnlineMachineIds()` returning null means the
presence room is not joined — status unknown, not offline.

## Device resources use `machine-monitor.ts`

Local renderer observer/snapshot state crosses protocol-v6 `machine-monitor` frames
and MUST sample without a cloud transport. Cloud observers/snapshots attach only after
the authorized remote bridge attaches, and detach on offline/revocation. Sampling is
observer-lease driven; never start OS probes permanently or persist snapshots.

## Machine Flock writes for this machine are local-first

After `repo.flush()`, call `LoroDocumentManager.markMachineFlockDocDirty(...)` (or pass
the manager as the sync scheduler) instead of awaiting `handle.syncOnce()` in a
user/RPC request path. `machine-flock-sync-coordinator.ts` owns the live room, dirty
state, and exponential retry; request-scoped `syncOnce()` failures must not make local
project add/update flows fail after the local write is durable.

## Durable commands are scanned, not evented

`machine-flock-command-watcher.ts` owns the machine's durable COMMAND subscription
(archive/delete/delete-local-project/provider-setup), separately from the sync
coordinator's write room. Flock rows are durable, so reconnect correctness is
SCAN-based: every authoritative join rescans every queue, and join or initial-sync
failures retry with bounded backoff. Events are only low-latency wakeups and carry
`authoritative`, which gates provider setup — a stale local setup row must not outrun
a remote cancellation. Route both the event and rejoin paths through
`MessageHandler.rescanMachineCommands`; a family wired to only one of them fails
silently, because its queue stops draining. Room-status recovery uses the shared
`isRecoverableStreamsRoomStatus` ('detached' is never recoverable). Local project
removal rules live in [../AGENTS.md](../AGENTS.md).

## Streams recovery has TWO signals and they must not be recombined

`connection-recovery.ts` has TWO signals. `onStreamsOnline` is cheap, unthrottled, and
fires on every health rising edge — it RELEASES work parked while offline (dirty
Machine Flock docs, which arm no timer of their own, plus the task/review automation
queues). `onMetaRoomSynced` is the EXPENSIVE "rescan the workspace index" signal whose
listeners do O(rooms) work: it waits for meta catch-up and is rate-limited to one
fan-out per `LODY_LORO_META_SYNCED_MIN_INTERVAL_MS` (30s), deferred and never dropped,
because the dispatch bootstrap scan is the only retry path for a session whose
reconcile threw. A fan-out after a real meta-room outage skips that floor; a
transport-only flap does not. Recombining them turned a single stuck room into ~3400
session reconciles/minute. Backoff is flap-aware for the same reason: health that does
not survive `LODY_LORO_HEALTH_STABILITY_WINDOW_MS` (5s) counts as a failed recovery and
charges the attempt counter instead of resetting it, and `force` must not clear that
history. Regression: `tests/reconnect-storm-repro.test.ts`.
