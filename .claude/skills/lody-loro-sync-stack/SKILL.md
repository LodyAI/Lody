---
name: lody-loro-sync-stack
description: The Lody Loro sync stack — how durable document synchronization and the ephemeral presence/liveness channels are separated, and the hard limits on what may be published through them. Use before adding or changing any presence, liveness, online-status, session-status, viewing-indicator, machine-monitor, progress-reporting or Loro Streams transport code, and when diagnosing a machine that reads offline while conversation sync looks healthy.
---

# Lody Loro sync stack

## Two planes, and they are not interchangeable

Lody moves state over Loro Streams on planes with different guarantees. Mixing them
is the source of the worst bugs in this subsystem.

**Durable documents** — session history, workspace meta, tasks, preview comments.
Ordered, persisted, replayed from an offset, and never dropped. Owned by
`StreamsTransportAdapter` (`apps/cli/src/lib/loro/streams-transport.ts`). If a
reader must receive something, it goes here.

**Ephemeral channels** — current liveness only. Not persisted with the document
stream, no history replay, latest-state oriented. A server may keep only a small
live fan-out queue and disconnect a slow subscriber rather than buffer every
intermediate update. Everything here is disposable by design.

Two ephemeral channels exist, on separate stream URLs and therefore separate
transports and separate queues:

| Channel | Constant | Carries |
| --- | --- | --- |
| `presence` | `LODY_PRESENCE_CHANNEL` (`packages/shared/src/presence.ts`) | machine heartbeat, session active status, session-viewing |
| `machine-monitor` | `packages/shared/src/machine-monitor.ts` | observer-leased device resource snapshots |

Keep them separate. Machine-monitor snapshots are far larger and more frequent than
anything the presence channel may carry; merging the two would put that traffic in
front of the machine heartbeat.

Healthy durable sync proves nothing about presence delivery. They are different
transports. A machine can sync conversations perfectly and still read offline.

## The invariant

**Publish only small, low-frequency liveness state on an ephemeral channel. Never
publish high-frequency or high-volume data on it.**

This is binding. The full statement is
[`specs/loro-ephemeral-presence-channel.md`](../../../specs/loro-ephemeral-presence-channel.md);
the scoped rules are in
[`apps/cli/src/lib/loro/AGENTS.md`](../../../apps/cli/src/lib/loro/AGENTS.md).

### Why it bites

One workspace owns ONE presence transport, and the machine heartbeat shares it with
every other presence writer in that workspace. Publication is strictly serial: one
update in flight. In consumed streams-crdt 0.16.2, the built-in adaptor coalesces
unsent single-key set/delete updates; it never replaces in-flight bytes or merges
distinct/unknown/multi-key updates. There is no heartbeat priority or distinct-key
traffic bound. `pendingLocalCount` counts logical writes, including superseded
ones, rather than POSTs. A writer that
produces faster than the network drains delays every later writer.

The heartbeat's timestamp is taken when the entry is created, not when it is sent.
An entry that waits longer than the freshness window (`LODY_PRESENCE_TTL_MS`, 90s;
heartbeat interval 30s) arrives **already expired**: readers receive it and still
classify the machine offline. The connection reports `joined` throughout, because a
backlog that drains successfully is not an error, so no reconnect path notices.

This happened. One session published a presence update per agent reasoning chunk and
produced 4,000 writes in three seconds; that workspace's machine read offline while
conversation sync stayed healthy. See
[the rejected note](../../../.agents/notes/rejected/bug-fix/2026-09-18-codex-transient-reasoning.md).

### Writer checklist

Before adding or changing an ephemeral writer, all four must hold:

1. **Bounded rate.** Driven by a timer, a lifecycle transition, or a user-visible
   phase change — never by each element of a stream. Per-chunk, per-token,
   per-keystroke, per-frame and per-loop-iteration publication are prohibited
   however small one payload is. Throttle a high-rate source to a fixed ceiling
   *before* it reaches the channel, so the rate is a property of the publisher.
2. **Bounded size.** A small fixed-shape record, every field schema-bounded in
   `packages/shared/src/presence.ts`. No unbounded strings, accumulated text, file
   contents, diffs, transcripts or session-growing collections.
3. **Latest-state only.** Current state under a stable key, tolerating the loss of
   every intermediate value. Anything order-dependent or must-not-miss is durable
   data.
4. **No shared-channel starvation.** Adding a writer changes the heartbeat's
   delivery budget. State the worst-case rate and payload size, not the typical one.

A feature that does not fit is not made to fit by shrinking one payload. It moves to
the durable transport, or it stays local and is never published.

Note the dedupe guard in `session-active-presence.ts` compares `(phase, detail)`. A
`detail` string that changes every emit — a percentage, a counter, a timestamp, a
streaming label — defeats it completely. That guard is not a rate limit.

### Local relay is not an exception, and is the right template

`packages/shared/src/local-loro-data-plane-server.ts` relays presence to the Electron
renderer over local IPC and already collapses a burst into one frame, snapshotting at
write time. Copy that shape when a producer is genuinely bursty.

## Ownership map

- `packages/shared/src/presence.ts` — channel constant, payload schemas, TTL, freshness predicate. Every new field gets a bound here.
- `apps/cli/src/lib/loro/workspace-presence.ts` — `WorkspacePresence`: scoped transport and 30s heartbeat; `PresenceReplica` owns the two synchronous stores. Locally-authored presence is written ONLY through `writeLocalOrigin`/`deleteLocalOrigin`. Never relay the workspace replica; the origin partition is load-bearing.
- `apps/cli/src/lib/loro/session-active-presence.ts` — the single owner of session active presence. Never publish or clear it from `setStatus`, RPC dispatch, permission/image callbacks or watcher recovery.
- `packages/components/src/providers/workspace-presence-transport.ts` — the renderer's session-viewing writer.
- `packages/components/src/atoms/presence.ts` — reader side. Liveness is three-state: `online` from a fresh heartbeat, `offline` only on a synced transport, `unknown` otherwise. Never report offline from an unsynced transport.
- `apps/cli/src/mcp/lody-mcp-server.ts` — dispatch guards. Keep the three states: block on a definite `offline` only, and let `unknown` proceed and fail against its own deadline. Collapsing `unknown` to offline refuses healthy Machines with a false reason whenever presence is merely still joining.

## Diagnosing "machine shows offline"

Work in this order and keep the claims separate.

1. **Is it the browser only?** Read it independently: `lody machine list --workspace <selector> --json`. This joins the presence room and recomputes fresh machine IDs. Read the `onlineStatus` field, not the legacy `online` boolean: `unknown` means the presence room could not be joined and nothing was checked, which is not evidence of an offline machine.
2. **Is it workspace-scoped?** Run the same read against another workspace on the same machine. Each workspace has its own transport and its own queue, so a burst in one workspace cannot affect another. Same machine online in workspace B and offline in workspace A points straight at a per-workspace publisher, not at the host.
3. **Is presence produced locally, and where is it waiting?** Follow the [current diagnostic stages and evidence limits](../../../.agents/docs/cli-lib-loro-presence.md#diagnostics-and-their-evidence-boundaries). Default logs retain a 30s health summary and slow/failed branches; trace holds individual local/auth/POST/barrier events. A joined read side with growing `postAgeMs` differs from pending auth with no POST. Do not invent absent append/error getters or infer queue depth from logical write counts.
4. **Is a producer flooding?** Check rate/size per publisher. Same-key unsent updates coalesce, while distinct keys and in-flight writes remain independent. The captured update-chain barrier can follow a superseding heartbeat and excludes later independent chains; its completion is neither an exact heartbeat send nor a peer receipt.
5. **Is acquisition or cleanup stuck?** Bootstrap may complete before an outbound flush lets `join()` return. The current 0.16.2 close may return while POST is still running. Neither joined status nor `close_returned` proves a fully released transport.

Do not restart the daemon to "fix" it. A restart destroys the evidence and the
backlog returns with the next burst.

## Stream identity (durable plane)

Verify against `packages/shared/src/index.ts` before relying on this; bucket ID is
exactly `lody`.

| Data | Stream ID |
| --- | --- |
| Workspace meta | `<workspaceId>:meta` |
| Session | `<workspaceId>:s:<sessionId>` |
| Task | `<workspaceId>:tk:<taskId>` |
| Task index Flock | `<workspaceId>:ti` |
| Preview comments | `<workspaceId>:pc:<sessionId>` |
| Code Collab file index | `<workspaceId>:fi:<masterSessionId>` |

A stream URL is `${gatewayBaseUrl}/ds/${encodeURIComponent('lody')}/${encodeURIComponent(streamId)}`.
Never concatenate an unencoded stream ID into the path — `:meta` must appear as
`%3Ameta`. The presence URL is that durable URL plus `?ephemeral=presence`
(`toLodyPresenceStreamUrl`).

The canonical identity uses `gatewayBaseUrl`, but the transport may route a request
to a control shard derived from the server-provided `shardHostSuffix`, and presence
may use its own host entirely. Shard selection is not stable; never hardcode it, and
inspect routing locally when needed, but never put raw URLs or credentials in
presence diagnostic logs.

## Scope

This skill is the public architecture and its limits. Inspecting a hosted
workspace's stored streams needs operator credentials and deployment identifiers
that do not belong in this repository; that runbook lives outside it. Nothing here
requires credentials, and read-only CLI subscriptions still create real reader
connections against the live room — do not flood a production room to test a theory.
