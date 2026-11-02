# Cross-machine reads must not hold rooms or degrade the transport

Status: implemented
Translation: current
Issue: [#2194](https://github.com/LodyAI/Lody/issues/2194)

[中文](2026-11-02-cross-machine-read-room-lifetime.zh.md)

## Abstract

A daemon MCP read of another Machine's data (`lody_agent_role_list` without a
Machine filter, `lody_session_list`, `lody_session_status_many`,
`lody_session_history`) joined that Machine's Flock or Session room and kept it
joined until the process ended. When such a room never finished its initial sync,
each 120 s `initial_sync_timeout` made the aggregate Streams status
`disconnected`. Recovery then reconnected the whole workspace, rejoined that room,
rescanned owned Sessions and skipped cloud side effects. The cycle repeated about
every 121 s until restart. The fix bounds the lifetime of rooms held by those reads
and stops one failed room from counting as a transport outage.

## Mechanism

- Catalog readers held every requested Flock forever: `held` had no removal path,
  the reader ended in `Effect.never`, and failures retried without a limit.
- MCP Session reads used `getOrCreateSessionDoc`. That call adopts the doc into the
  shared, unrefcounted `sessions` cache, which nothing evicts for another Machine's
  Session.
- In `loro-repo@0.25.0` the aggregate is `disconnected` when any room is in error.
  `connection-recovery.ts` treated that as unhealthy: it reconnected the workspace,
  ran the meta-ready ceremony and set `isTransportConnected()` to false.
- In `streams-crdt@0.19.2` `initial_sync_timeout` is retryable. The failed join
  state stays attached, and `repo.reconnect()` revives it through `rejoin()`.

The same code was present in 0.108.x. Cross-machine Roles and reads made the
trigger common. The Streams patch added in 0.109.0 runs only with payload
protection, so it does not explain the plaintext reports.

## Decision

1. **Health follows the meta room.** While the meta room is joined, an aggregate
   `disconnected` is reported as `rooms-degraded`. It is healthy for recovery
   purposes: only the failed rooms are swept, starting about 1 s after the failure
   and backing off to 30 s while they keep failing, so this Machine's own room
   recovers as fast as before. No
   transport-wide reconnect, recovery edge or O(rooms) rescan starts.
   `isTransportConnected()`, which gates cloud side effects, is true while the meta
   room is joined. `waitUntilMetaSynced` waits for the meta room even when another
   room made the aggregate disconnected. Adapter close and real outages take the
   meta room down too, so they keep the full recovery path.
2. **Catalog leases are transient.** Metadata and the workspace Flock stay joined.
   Any other catalog reader is released `TRANSIENT_CATALOG_IDLE_MS` (5 min) after
   the last `hold`/`ready` call. An idle reader stops waiting for its baseline and
   stops retrying. A release defect is reported at
   shutdown but is not cached: the next read starts a fresh reader.
3. **Session reads of another Machine are transient.**
   `readSessionDocTransiently` reads a cached or initializing doc in place.
   Otherwise it opens a temporary `SessionDocument` outside `sessions`, under the
   doc's local ownership chain, and destroys it with status preserved. The cloud
   room is joined outside that wrapper. History waits at most 8 s for the first
   sync, unless a room retained by an earlier read is still pending; list and
   status do not wait. The room is then kept until its first sync
   completes or `TRANSIENT_DOC_ROOM_RETAIN_MS` (150 s, longer than the 120 s
   Streams deadline) elapses. Releasing it right after the read would abort every
   slow first sync, so a large transcript would never reach the replica and a
   finished turn would keep reporting busy. The retained room shares the renderer
   bridge registry, so a live `getOrCreateSessionDoc`, a renderer leave and
   manager cleanup cancel it. A failed wrapper cleanup is logged and never
   replaces the completed read. The doc stays loaded while a local renderer room
   or a retained room still uses it. This Machine's own Sessions keep the cached
   execution doc.

## Alternatives

- **Only adopt [loro-streams#440](https://github.com/loro-dev/loro-streams/pull/440)**
  (240 s deadline, non-retryable timeout). This lengthens each cycle and changes
  which caller retries. Catalog retries still rejoin, and every failure still makes
  the aggregate disconnected, so the machine-wide effect remains. It is still worth
  adopting once published.
- **Change the aggregate in loro-repo.** That is the correct long-term owner of
  per-room status, but it needs an SDK release. The Lody-side health rule does not
  depend on it and stays correct if the SDK later reports per-room failures
  separately.
- **Destroy cached Session docs after MCP reads.** Rejected: `sessions` has no
  refcount, and destroying a doc another holder adopted breaks that holder (see
  `apps/cli/src/lib/loro/AGENTS.md`).
- **Keep the old recovery and only add reconnect backoff.** That backoff already
  existed (`tests/reconnect-storm-repro.test.ts`). It bounds the reconnect rate but
  still marks the machine offline and skips cloud side effects for the whole
  failure.

## Trade-offs

- After 5 idle minutes, the first catalog read reports `catalog_syncing` again
  until the new reader reaches its baseline.
- List and status for another Machine's Session answer from the replica as it
  is; the retained room refreshes it for the next read. Liveness still comes from
  presence and the owner's RPC snapshot.
- A room that never syncs is joined again by each later read and released after
  150 s. Its failures stay `rooms-degraded` and do not affect the machine.
- Why some rooms never finish their initial sync from another machine
  (server, proxy or room data) is not addressed here.

## Verification

- `apps/cli/src/lib/loro/connection-recovery.test.ts` covers a failed doc room with
  a joined meta room: a per-room sweep after about 1 s that backs off, and
  cloud side effects and meta waits still available. It also covers a
  disconnected transport without a meta room.
- `apps/cli/tests/reconnect-storm-repro.test.ts` scenarios A and D: a flapping
  aggregate with a joined meta room causes zero fan-outs and scans. Scenario B: a
  real outage still backs off.
- `apps/cli/src/lib/loro/workspace-catalog-sync.test.ts` covers another Machine's
  catalog that never syncs: it is released after the idle window, extended by
  reads, not rejoined without a read, and can be joined again later.
- `apps/cli/src/mcp/daemon-session-tools.test.ts` covers another Machine's Session:
  status keeps the room until its first sync and then releases it; history
  answers from the replica when the first sync stalls, does not wait again while
  that room is retained, and releases it at the bound; a later read joins again; a failed wrapper cleanup keeps the
  completed read.
- Not verified against live Streams with a stalled room. The renderer-protection
  and cancellation branches of the retained room are covered by review, not by a
  test.
