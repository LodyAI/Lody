# apps/cli/src/lib/loro — Loro repo/runtime layer

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

## Mirrors over synced docs tolerate unknown root keys

Synced Mirrors use `ignoreUnknownProperties: true`; unknown newer roots must not
block client writes. Regression:
`packages/shared/tests/session-doc-forward-compat.test.ts`.

SessionDocument's private Mirror is control-only. HistoryWriter writes; SessionData
reads. `session-agent-writes.ts` reuses shared planners over that writer, never
UI port methods or a second writer.
Replacement rules: [shared](../../../../../packages/shared/AGENTS.md#session-history).

## Opening a doc pulls its stream

`getOrCreateSessionDoc()` joins/pulls via `SessionDocument.init()` and stays cached
until `cleanSessionDoc`; each open subscribes and fully syncs.

Rules:

- Renderer metadata is imported into the meta Flock with no transport; the
  metadata live monitor must start at repo init (`ready()`), or
  `getDocMeta` stays stale and dispatch misses `latestUserMsgId`.
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
  and `cleanSessionDoc`/`destroy` disposes every holder's mirror/subscriptions
  (the dispatch watcher's `watchedSessions` guard blocks re-subscription). When you cannot
  prove sole ownership, leave the doc cached. Never call
  `repo.unloadDoc`/`unloadDocRoom` on a live wrapper directly either (the room
  binding would leak; see `SessionDocument.destroy` in `doc.ts`), and never let
  teardown write status/meta for docs that must stay hidden (e.g. unfinished
  fork targets).

The dispatch watcher's contract, "session metadata is the activation index", is
documented in `../../session/AGENTS.md` and applies to any module enumerating rooms.

`getOrCreateSessionDoc(..., { skipAutoRead: true })` affects only newly initialized
wrappers. Use it for observation in an isolated command manager, never to change
a cached execution wrapper's policy. Read-only release must preserve status;
see [observe scopes](../../commands/session-observe-runtime.ts).

## Streams cursors are replica-bound

Daemon/commands share `repo.sqlite3`, never replicas. Native leases own Meta/Flock
checkpoints. Daemon Doc cursors use `createDocumentRemoteCursorStore`; no shared
`remoteCursorStore` or schedule `onPersist*`. Test: `tests/cli-streams-replica-checkpoints.test.ts`.

`WorkspaceRepoLegacy` retains Docs after failed eviction. Reopen destroyed views
in the same-key owner; share init and retain release ownership. Reject stale joins.

## Shared ACP runtime config contains no secrets

`SessionDocument.applyAcpRuntimeConfigPatch` is the durable boundary for the
workspace-shared runtime baseline. It must remove every option id matched by
`isSensitiveAcpConfigOptionId`, even when an upstream caller already filtered the
ACP response; otherwise a future agent can persist and broadcast credential-like
selector values to collaborators.

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
Only Legacy executes; no kernel Promise/timers, runtimes or POST/SSE queues.
Failed release retains work/Cause/owner and fences its generations, not the workspace.
Registry retires failed owners. Close joins; revoke preserves local production.
CLI owns registry/token Scopes; durable/presence share one provider.
`platform/presence.ts` consumes the native SDK.

## Device resources use `machine-monitor.ts`

Local renderer observer/snapshot state crosses protocol-v6 `machine-monitor` frames
and MUST sample without a cloud transport. Cloud observers/snapshots attach only after
the authorized remote bridge attaches, and detach on offline/revocation. Sampling is
observer-lease driven; never start OS probes permanently or persist snapshots.

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

In `connection-recovery.ts`, `onStreamsOnline` fires unthrottled on every health
rising edge, releasing dirty Machine Flock docs (no timer) and automation queues.
`onMetaRoomSynced` waits for meta catch-up before O(rooms) rescans. Defer, never
drop, fan-out within `LODY_LORO_META_SYNCED_MIN_INTERVAL_MS` (30s): dispatch bootstrap
is the retry path after reconcile throws. A real meta outage skips that floor;
a transport-only flap does not.

Health shorter than `LODY_LORO_HEALTH_STABILITY_WINDOW_MS` (5s) charges a failed
recovery attempt; `force` must not clear flap history. Regression:
`tests/reconnect-storm-repro.test.ts`.

Session retries and online sweeps use native per-room sync/reconcile with borrower
cancellation and existing deadlines. SDK health may prove failed initialization
while Repo still says joining; ordinary baselines/live 4xx keep SDK retry ownership.
Server force stays per-room; reset only a failed transport. Keep local peer recovery.
