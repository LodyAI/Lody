# CLI presence: origin partition, single ownership, delivery budget

How the CLI produces liveness on the Loro ephemeral presence channel, and what bounds
every writer. [`apps/cli/src/lib/loro/AGENTS.md`](../../apps/cli/src/lib/loro/AGENTS.md)
requires this page to be read before presence is published or `workspace-presence.ts` /
`session-active-presence.ts` change, because the rules below bind those files. Human
intent and the reader contract are in
[`specs/loro-ephemeral-presence-channel.md`](../../specs/loro-ephemeral-presence-channel.md).

## The channel is a shared, serial delivery budget

Durable documents and presence travel on different transports. Healthy conversation
sync therefore proves nothing about presence delivery, and a machine can sync
perfectly while reading offline.

One workspace owns ONE presence transport, and the machine heartbeat shares it with
every other presence writer in that workspace. Publication is serial. In
`@loro-dev/streams-crdt@0.17.0`, the built-in `EphemeralStoreAdaptor` supplies
`localUpdateKey`: newer single-key set/delete updates replace older unsent updates
for the same key, while in-flight and unknown/multi-key updates remain independent.
All three Lody construction sites use that adaptor directly. Coalescing does not
prioritize heartbeats or bound distinct-key traffic, so publishers still own the
rate and size budget. The subscription's `pendingLocalCount` counts unacknowledged
logical updates, not the number of POSTs after coalescing.

The failure mode is specific and quiet. A heartbeat's `updatedAt` is taken when the
entry is created, not when it is sent, so an entry that waits longer than
`LODY_PRESENCE_TTL_MS` (90s) arrives already expired — readers receive it and still
classify the machine offline. Throughout, the room reports `joined`, because a backlog
that drains successfully is not an error; status recovery only reacts to `error`
and `disconnected`, so no recovery path observes the problem, and `joined` even
triggers local republishing, adding more writes.

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
over local IPC through the native process-wide writer, coalescing changes and
snapshotting at write time. The final clear/delete retains its follow-up; every
workspace on a slow socket shares its export/drain backpressure. This lower unit
does not migrate the workspace presence producer or cloud transport. See the
[local-plane writer](cli-lib-local-loro-data-plane.md#shape).

## Token-provider ownership

Durable and ephemeral consumers may borrow the same token provider, but each
native auth call owns only its waiter lease. Cancelling one call cannot abort a
refresh another lease still needs. Last release, credential replacement and close
await actual token I/O; bounded failure retains the old owner and fences new work.
Only the explicit Legacy facade's old-protocol callback maps an all-auth Cause to
undefined; native getToken/auth preserve typed failure. Transient failure, deadline,
interruption and cleanup failure stay observable, including mixed Causes. The official cloud
composition provides native token ports, while unmigrated consumers retain the
explicit Legacy facade. See [the provider contract](../../packages/shared/src/loro-streams-token/README.md).
This does not change presence payloads, rate limits or durable CRDT work.

## Two stores, partitioned by origin

`PresenceReplica` (`presence-replica.ts`) keeps TWO stores and the distinction is
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
fiber run whether or not `attachStreams` ever happens, so a local-first renderer reads
liveness over the local plane while offline.

## Session active presence has exactly one owner

`session-active-presence.ts` alone owns session active presence. It starts once for a
visible CLI turn, accepts phase updates, heartbeats while active, and clears on the
owning Effect release. Never publish or clear session presence from `setStatus`, RPC
dispatch, permission or image callbacks, or watcher recovery paths — a second writer
makes the clear path unreliable and leaves sessions showing work that ended.

Cancellation and initialization-stall finalizers run before the presence child Scope
closes; the Turn slot is released afterward, so the previous release cannot clear
a successor. Raw ACP drain retains presence until settlement or confirmed termination.
The lease kernel also owns native Clock/Schedule heartbeats and a per-generation
Deferred initialization-stall signal. Phase/detail changes reset its silence budget;
duplicate status does not. MessageHandler composes `holdSessionActivePresence` into the
visible Turn's child Scope. Exit, archive and GC callbacks cannot release that lease.
Late startup phase callbacks are fenced against the exact Turn runtime. Failed local
clear keeps its generation and Cause, blocks new holds, and allows explicit local
`retryRelease`; it does not automatically recover a failed upper Turn finalizer.

`session-active-presence-legacy.ts` is the single MessageHandler execution entry and
retains the existing analytics flush as unfinished Legacy orchestration. Native
heartbeats only admit synchronous diagnostics. Shutdown retires new holds, stops
SessionManager producers and awaits lease and monitoring release before the final
ACP/history flush and evidence/document teardown. Each observation is bounded at five seconds; timeout keeps the original
owner and refuses document teardown. This completes the session lease/heartbeat
responsibility, while full Session/Turn and daemon lifecycle migration remains pending.

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

## Diagnostics and their evidence boundaries

The CLI root supplies one `WorkspacePresenceOwners` registry alongside its shell
cache. `doc.ts` acquires a child workspace through the deprecated
`presence-legacy.ts` execution facade. The native owner uses child Scopes for
heartbeat, shared bootstrap, probes and remote generations; `platform/presence.ts`
composes the published SDK's native API. It adds no POST/SSE queue or token cache.
Durable and ephemeral auth borrow one workspace-owned native token provider through
the same application executor. Cloud revocation ends remote sinks and then that
provider, while local presence stays alive; local-only creation reads no credentials
and makes no cloud request. Application shutdown stops every retained workspace.

| Evidence                                                                     | Meaning                                                                                                                            |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| SDK `auth`, `bootstrap`, `queue`, `post`, `ack`, `retry`, `stall`, `release` | Actual native transport stages, projected as finite categories/counts.                                                             |
| Owner `joined` / `bootstrap`                                                 | Read-side bootstrap availability; status changes retire readiness synchronously.                                                   |
| Owner `heartbeat`                                                            | Local publication timestamp and queue snapshot, sampled once per 30 seconds.                                                       |
| Owner `barrier`                                                              | Captured logical chain completion; later independent writes are excluded. Not an exact heartbeat acknowledgement or peer receipt.  |
| Owner `stall`                                                                | The pending local upload made no observed progress for its bounded interval; warns without reconnecting automatically.             |
| Owner `retry`                                                                | Bootstrap/rejoin attempt and bounded safe failure category.                                                                        |
| Owner `release`                                                              | Remote admission retired. Success requires actual SDK/task cleanup and Scope closure; timeout retains the original work and owner. |

Successful per-operation/heartbeat events use opt-in trace. SDK errors use debug;
bounded bootstrap/retry/stall diagnostics use warn. Unknown error text, payloads,
tokens, URLs and Cause contents never enter structured fields. Effect annotations
continue through the existing daemon file logger's allowlist; no telemetry sink is added.

`streams-crdt@0.17.0` with its `streams-client@0.10.0` dependency aborts owned I/O
and retains raw work that ignores abort. Failed close forbids replacement; explicit
`retryCleanup` joins original work and calls the SDK recovery entry after settlement.
The workspace applies the same rule to token Scope failures. Concurrent close callers
share the completion receipt, and full Causes survive the Legacy boundary.
The SDK's retirement cancellation fix is recorded in
[loro-streams#410](https://github.com/loro-dev/loro-streams/pull/410).

See the [P5 decision](../notes/implemented/architecture/2026-10-12-effect-workspace-presence.md)
for acceptance and limits. Session-active leases and local relay pacing still have
separate P6/P7 ownership work; this does not finish Session/Turn lifecycle migration.

## Diagnosing "machine shows offline"

1. Read independently with `lody machine list --workspace <selector> --json`. A room warning means unknown, not offline. Compare another workspace on the same machine to isolate its transport.
2. Read owner `stall` / `retry` records and SDK stage diagnostics in the configured Lody data directory's logs. `room=joined` with a nonempty, stalled queue identifies an outbound problem; auth/POST stages help isolate it. Neither proves a production root cause.
3. Enable trace for individual local/auth/POST/barrier events when needed. Check the diagnostic generation and attempt, never interpret a barrier as that heartbeat's exact send or a peer receipt. Slow/failed branches remain available without trace.
4. Check publishers against the rate/size budget. Coalescing helps same-key unsent writes, but distinct-key traffic and in-flight bytes remain independent. Do not infer physical POST counts from `pendingLocalCount`.
5. Keep transport status, local writes, server response, snapshot barrier completion and peer observation separate. Restarting destroys the evidence and does not fix a flooding writer.
