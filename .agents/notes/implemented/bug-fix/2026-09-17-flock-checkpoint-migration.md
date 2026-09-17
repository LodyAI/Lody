# Adopt replica-owned Flock progress

Status: implemented
Translation: current

[中文](2026-09-17-flock-checkpoint-migration.zh.md)

## Abstract

Flock clock summaries can conceal missing keys, so advancing progress without
durably recording accepted data can preserve a hole across restart. The upgrade
to loro-repo 0.20.3 adopts exact-record persistence and IndexedDB replica-bound
checkpoints; renderer recovery now invalidates that actual checkpoint. CLI uses
awaited per-resource writes and memory progress because SQLite lacks atomic
replica recovery upstream. CLI cold starts replay more data; historical remote
completeness is not established by this change.

## Decision and evidence

The removed ready() patch is included upstream. The attempted inclusiveVersion
substitution was reverted: those fields filter subsequent exports, not completion
checks. A real-Wasm local-server test shows that a peer's overwritten high clock
must not suppress a later repaired lower-clock key.

Renderer uses createRepoStreamsPersistence with the old cursor store only for
LoroDoc. New Flock checkpoints start empty, preserve existing data and trigger
bootstrap. Recovery bypass and deletion target the current repo-owned checkpoint.

CLI previously returned from onPersist callbacks after scheduling a debounced
global flush. Scoped persistMetaNow/persistDocNow/persistFlockDocNow barriers now
await storage. The unused coalescer and its suite were removed. Rather than copy
unproven legacy cursors or duplicate upstream SQLite recovery internals locally,
the explicit interim policy is memory progress, per loaded Flock object. A future
SQLite capability can replace it after atomic capture/invalidation tests pass.

Tests exercise real Flock, real SQLite and fake-indexeddb: v3 layout migration,
same-vector repair/reopen, retained local records, independent live replicas,
failure/retry and blocking writes. Existing runtime lifecycle suites remain in
scope. No network or production data was used; fake-indexeddb is not evidence of
physical power-loss durability. No production caches were deleted or migrated by
the agent. [Contract](../../../../specs/flock-checkpoint-recovery.md).

Additional tests run the published StreamsTransportAdapter for Meta and named
Flock against synthetic HTTP responses: snapshot bootstrap repairs a same-vector
hole and preserves a local-only record; reopening restores all records and uses
the saved offset without another bootstrap. The two renderer suites pass 23
tests, and the components typecheck passes. Source inspection confirms snapshot
import merges into the live Flock, and cursor saving awaits the data barrier.
This validates IndexedDB recovery, not persistent SQLite checkpoints or recovery
of records already missing from the remote snapshot and retained stream tail.

## Follow-up review: unresolved local-plane repair propagation

The durability checks now reopen storage without destroying/flushing the writer,
and inject data-save and checkpoint-save failures through the published transport
for both Meta and named Flock. Nine persistence tests pass: failed data writes do
not advance recovered progress, failed checkpoint writes preserve saved data, and
retry repairs the missing key even though it is already present in memory.

A separate real-Wasm server reproducer confirms an unresolved migration gap:
server and local reader first contain B at peer aa clock 2; bootstrap later adds
A at aa clock 1 to the server. Its version remains aa:2, so the local server exports
against lastSentVersion aa:2 and emits no repair. The reader still lacks A.
The earlier regression covered only a disappeared peer frontier and does not
prove this case. This is an existing local-protocol limitation, not a regression
introduced by the persistence helper, but prevents claiming end-to-end repair for
local-primary readers until their own cloud catch-up repairs them.

The owning local-server suite records this as an explicit `it.fails` regression;
its green suite result means the known failure reproduced, not that it is fixed.
Remove that marker only when exact changed-key forwarding or a reconciliation
path repairs the recipient. Switching to inclusiveVersion does not fix it.
This review changes tests/evidence only; the production fix is still pending.

Further lifecycle review adds four passing cases: unload/reload preserves the
checkpoint while rejecting stale handles; purge invalidates another live replica
generation; an older checkpoint saved last retains both replicas data; Meta and
named-Flock same-vector tombstones survive reopening and reject stale-record
replay. The lifecycle case combines unload and purge in one test. These are
deterministic IndexedDB/Flock tests, not physical crash tests. The two renderer
suites now pass 31 tests; components typecheck passes. No additional P0/P1 was
confirmed in these paths. The local-plane repair gap above remains unresolved.
