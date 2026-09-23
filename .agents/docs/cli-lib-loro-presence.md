# CLI presence: origin partition, single ownership, delivery budget

How the CLI produces liveness on the Loro ephemeral presence channel, and what bounds
every writer. [`apps/cli/src/lib/loro/AGENTS.md`](../../apps/cli/src/lib/loro/AGENTS.md)
requires this page to be read before presence is published or `presence.ts` /
`session-active-presence.ts` change, because the rules below bind those files. Human
intent and the reader contract are in
[`specs/loro-ephemeral-presence-channel.md`](../../specs/loro-ephemeral-presence-channel.md).

## The channel is a shared, serial delivery budget

Durable documents and presence travel on different transports. Healthy conversation
sync therefore proves nothing about presence delivery, and a machine can sync
perfectly while reading offline.

One workspace owns ONE presence transport, and the machine heartbeat shares it with
every other presence writer in that workspace. Publication is strictly serial: one
update in flight, the rest in a FIFO that does not merge superseded entries, does not
prioritize heartbeats, and has no length bound. Those are properties of
`EphemeralStreamCrdt` in `@loro-dev/streams-crdt`, which this repository does not
control, so the bound has to be honored by publishers.

The failure mode is specific and quiet. A heartbeat's `updatedAt` is taken when the
entry is created, not when it is sent, so an entry that waits longer than
`LODY_PRESENCE_TTL_MS` (90s) arrives already expired — readers receive it and still
classify the machine offline. Throughout, the room reports `joined`, because a backlog
that drains successfully is not an error; `handleRoomStatus` only reacts to `error`
and `disconnected`, so no recovery path observes the problem, and `joined` even
triggers `republishLocalState()`, adding more writes.

### What this forbids

Trigger a presence write ONLY from a timer, a lifecycle transition, or a user
navigation. Never from a stream, progress or chunk callback, however small one payload
is. Throttle a high-rate source to a fixed ceiling before it reaches the channel, so
the publication rate is a property of the publisher rather than of the source. Bound
every field in `packages/shared/src/presence.ts`; unbounded strings and accumulated
text are not liveness state.

`SessionActivePresenceController.setPhase` dedupes on `(phase, detail)`. That guard is
NOT a rate limit: a `detail` that changes on every emit — a percentage, a counter, a
streaming label — defeats it completely and publishes at the source's rate.

`packages/shared/src/local-loro-data-plane-server.ts` relays presence to the renderer
over local IPC and already collapses a burst into a single frame, snapshotting at
write time. It is the template to copy when a producer is genuinely bursty.

## Two stores, partitioned by origin

`CliPresenceRuntime` (`presence.ts`) keeps TWO stores and the distinction is
load-bearing:

- `store` is the workspace-wide replica: this process's writes PLUS every peer seen in
  the shared room. Machine-online checks and the PR poller read it.
- `localOriginStore` holds ONLY entries this process authored, and is the sole payload
  of the local data plane (`encodeLocalOriginPresence` / `subscribeLocalOriginPresence`).

The local plane splits by ORIGIN, not by content. Relaying the replica would hand the
renderer's "local" snapshot authority over peers it already replicates live from the
cloud. Write locally-authored presence exclusively through `writeLocalOrigin` /
`deleteLocalOrigin`, never directly to a store; `specs/local-first-two-plane.md`
explains the partition.

Presence production does not depend on the cloud. The store and the 30s heartbeat
timer run whether or not `attachStreams` ever happens, so a local-first renderer reads
liveness over the local plane while offline.

## Session active presence has exactly one owner

`session-active-presence.ts` alone owns session active presence. It starts once for a
visible CLI turn, accepts phase updates, heartbeats while active, and clears on the
owning Effect release. Never publish or clear session presence from `setStatus`, RPC
dispatch, permission or image callbacks, or watcher recovery paths — a second writer
makes the clear path unreliable and leaves sessions showing work that ended.

Its scope covers ALL turn-finalization stages, so optional cloud side effects inside
it (usage flush, completion notification, Live Activity sync) MUST go through
`MessageHandler.runTurnCloudSideEffect`. Third-party calls such as GitHub and model
APIs are a different reachability domain and are NOT gated by it.

## Reading liveness

Machine liveness is three-state, and the states are not interchangeable. A fresh
heartbeat means online. The absence of one on a SYNCED transport means offline. An
unsynced transport means unknown. `getOnlineMachineIds()` returning null means the
presence room is not joined — status unknown, not offline.

Carry that distinction all the way to the consumer instead of flattening it. Only a
definite offline may block work: the MCP dispatch guards refuse on `'offline'` alone,
so a Machine whose presence room merely has not joined stays usable and fails later
against its own deadline if it really is down. `lody machine list` reports
`onlineStatus` (`online` / `offline` / `unknown`) beside the legacy `online` boolean, so
a `--json` consumer parsing stdout is no longer told a confident offline when the truth
is that nothing could be checked.

Durable `MachineMeta.lastSeen` is retired and is not written even at registration;
machine online checks read presence only. Never reintroduce periodic doc-meta writes
(`lastSeen` / `lastRunningSeen`): they stall Loro flush, and meta timestamps are
written only at status transitions.

## Diagnosing "machine shows offline"

Keep these claims separate, in this order:

1. Read liveness independently of the browser with `lody machine list --workspace <selector> --json`. A presence-room warning means unknown, not offline.
2. Compare another workspace on the same machine. Each workspace has its own transport and queue, so one workspace offline while another is online points at a per-workspace publisher, not at the host.
3. Read the counters on the heartbeat line itself. `writeMachineHeartbeat` appends `queued=` (shared-queue depth), `room=`, `sinceLastAppendMs=` (how long the write path has made no progress) and, when uploads are stuck, `writeError=`/`writeErrorRetryable=`. The line still proves only a LOCAL store write — it is emitted without awaiting any publish acknowledgement — but the counters describe the queue that write just entered.
4. A `Loro presence machine heartbeat delivered` line reports `ageAtSendMs`, the heartbeat's age when it actually left the process, and `queuedAhead`. At or past the freshness window it is logged at WARN: that heartbeat reached readers already expired, so they still report this machine offline. One delivery probe runs at a time; while one is outstanding, later heartbeat lines carry `unackedHeartbeatSeq=`/`unackedForMs=`, which is how a permanently stalled queue surfaces instead of going silent.
5. Count presence writes per second per session in `~/.lody/logs/`. Hundreds or thousands of writes from one session in a few seconds is the signature; correlate its onset with the offline interval.
6. Room status `joined` with a backlog is indistinguishable from healthy on the room status alone. Connection health is not delivery freshness — read `queued=` and `ageAtSendMs` instead.

Restarting the daemon destroys the evidence and the backlog returns with the next
burst; it is not a fix.
