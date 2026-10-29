# apps/cli/src/lib/loro — Loro repo/runtime layer

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

## Mirrors over synced docs tolerate unknown root keys

Synced Mirrors use `ignoreUnknownProperties: true`; unknown roots must not block writes.
Test: `packages/shared/tests/session-doc-forward-compat.test.ts`.

SessionDocument Mirror is control-only. HistoryWriter writes; SessionData reads.
`session-agent-writes.ts` uses shared planners, never UI ports or a second writer.
Replacement rules: [shared](../../../../../packages/shared/AGENTS.md#session-history).

## Opening a doc pulls its stream

`getOrCreateSessionDoc()` initializes, joins and pulls the room immediately;
the manager retains it until `cleanSessionDoc`. Each open costs a subscription
and full initial sync.

Rules:

- Renderer metadata is imported into the meta Flock with no transport; the
  metadata live monitor must start at repo init (`ready()`), or
  `getDocMeta` stays stale and dispatch misses `latestUserMsgId`.
- Never open docs in a `listAliveRoomIds` or other workspace-wide loop:
  historical rooms would stall startup and flood Streams.
- Bulk/startup/recovery scans must first filter to candidates through indexes
  that do not join rooms: `repo.getDocMeta(roomId)` meta records, the `e/`
  existence index (`lib/loro/repo-existence.ts`), or a purpose-built local index
  (example: `session/session-fork-operation-store.ts`). Open docs only for the
  filtered candidates, under a concurrency bound (`mapWithConcurrency`, 4).
- To drop a doc you opened for inspection, first prove no other holder adopted
  it: `LoroDocumentManager.sessions` is a shared cache with **no refcounting**,
  and `cleanSessionDoc`/`destroy` disposes every holder's mirror/subscriptions
  (the dispatch watcher's `watchedSessions` guard blocks re-subscription). When you cannot
  prove sole ownership, leave the doc cached. Never call
  `repo.unloadDoc`/`unloadDocRoom` on a live wrapper directly either (the room
  binding would leak; see `SessionDocument.destroy` in `doc.ts`), and never let
  teardown write status/meta for docs that must stay hidden (e.g. unfinished
  fork targets).

Room enumeration follows the metadata activation index: `../../session/AGENTS.md`.

`getOrCreateSessionDoc(..., { skipAutoRead: true })` affects only newly initialized
wrappers. Use it for observation in an isolated command manager, never to change
a cached execution wrapper's policy. Read-only release must preserve status;
see [observe scopes](../../commands/session-observe-runtime.ts).

## Streams cursors are replica-bound

Per identity, share `repo.sqlite3`, not replicas: Meta/Flock cursors use `createRepoStreamsPersistence`, LoroDoc cursors from
`createDocumentRemoteCursorStore` (shared rows: daemon only). No shared
`remoteCursorStore` or schedule-only `onPersist*`. Test:
`tests/cli-streams-replica-checkpoints.test.ts`.

## Shared ACP runtime config contains no secrets

`SessionDocument.applyAcpRuntimeConfigPatch` must remove every option matched by
`isSensitiveAcpConfigOptionId`, even from already-filtered ACP responses, before
persisting the workspace-shared baseline.

## Presence is ephemeral and partitioned by origin

Read [presence contracts](../../../../../.agents/docs/cli-lib-loro-presence.md) before changes:
origin stores and session ownership. Intent: `specs/loro-ephemeral-presence-channel.md`.

The workspace's ONE serial queue carries machine heartbeats. Publish only from a
timer, lifecycle transition or navigation; never stream/progress/chunk callbacks.
Bound every field in shared presence schemas. Same-key coalescing does not bound
distinct keys or in-flight writes; `(phase, detail)` dedupe is not a rate limit.
Safe fields only; barriers are not exact heartbeat/peer receipts. Joined/close
does not prove fresh delivery/POST cleanup. Never write periodic doc-meta lastSeen or
lastRunningSeen; write meta timestamps only at status transitions. MachineMeta.lastSeen
is retired even at registration. Online checks use presence; null from
getOnlineMachineIds means unknown, never offline.

`session-active-presence.ts` owns native Turn leases, Clock heartbeats and latched
stall signals. Only its lease release clears presence; incidental lifecycle clears
cannot retire a Turn. Its Legacy entry owns execution/analytics. Intent:
`specs/session-initialization-deadline.md`.

`workspace-presence.ts` owns Scopes; `presence-replica.ts` is synchronous.
Only Legacy entries execute. No kernel Promise/timers,
extra runtime or POST/SSE queue. Failed release retains work/Cause/owner and
fences its generations; the registry retires it, never blocking the workspace.
Close joins completion. Revoke preserves local
production. CLI owns registry/token Scopes; workspace token users share one kernel.
`platform/presence.ts` uses the published SDK native entry.

## Device resources use `machine-monitor.ts`

Local renderer observer/snapshot state crosses protocol-v6 `machine-monitor` frames
and MUST sample without a cloud transport. Cloud observers/snapshots attach only after
the authorized remote bridge attaches, and detach on offline/revocation. Sampling is
observer-lease driven; never start OS probes permanently or persist snapshots.

## Catalog readers

Share Promise Repo; close readers first. Timeouts end waiters.
Retry baseline errors in-place. Role writes confirm remote sync.
Default MCP fallback requires an actual persisted remote cursor for that workspace
Flock, not local rows or an empty checkpoint generation. Keep the pinned SQLite
checkpoint reader read-only; cover receipt, restart and purge through real Streams
persistence when changing this SDK-format compatibility boundary.

## Machine Flock writes for this machine are local-first

After `repo.flush()`, call `LoroDocumentManager.markMachineFlockDocDirty(...)` (or use
the manager as sync scheduler); never await `handle.syncOnce()` in user/RPC paths. `machine-flock-sync-coordinator.ts` owns the live room, dirty
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
Machine Flock docs, which arm no timer of their own, plus the scheduled automation
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

## Personal memory

`personal-memory.ts` owns user/workspace SQLite storage. Never put personal Docs
or metadata in the workspace Repo or Streams. Resolve local rooms only for the
manager's user. Agent access uses frozen turns, live Role bindings and the owner's
memory catalog; Renderer edits arrive through local Loro replication. Local room
resolution replicates catalog and memory Docs as they are and never initializes one.
