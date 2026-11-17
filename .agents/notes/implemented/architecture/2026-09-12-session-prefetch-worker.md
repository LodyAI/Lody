# Move session prefetch into a serial Worker

Status: implemented
Translation: current

[中文](2026-09-12-session-prefetch-worker.zh.md)

## Abstract

Background prefetch previously reused the Session store, so it loaded a full LoroDoc and created a
history-carrying Mirror even when the user had not opened a long conversation, blocking the
renderer's UI main thread. Prefetch is now a raw document sync inside a dedicated Worker whose
result lands in a separate binary snapshot cache; the main thread receives only a completion status.
Each renderer shares one serial task slot, cancellation terminates the Worker outright, and a
finished cache is merged on demand when the foreground opens the target session. The import cost of
deliberately opening a long conversation and the CLI sender's load cost both remain; this change does
not claim acceptance against real long-conversation performance.

## Decision

```text
metadata candidates → single-task queue → Worker: LoroDoc sync → separate snapshot cache
user opens session → cancel that task → merge cache into the foreground Doc → UI Mirror
```

Moving only the scheduler into a Worker does not isolate Doc import, and removing only the Mirror
does not isolate Loro's own cost. Another possible direction is caching the transport binary
directly, but the current adapter depends on document version vectors and bidirectional sync, so this
round keeps a real Doc and uses the existing transport inside the Worker. It does not share the
renderer's Repo database, avoiding two independent instances writing the same persisted state.

The Worker exits at the end of each task; both concurrency and batch size are 1. The cooldown between
batches is 1.5 seconds on desktop/web and 3 seconds on mobile. The separate cache is capped at
128 MiB / 64 entries, storing the snapshot and the activity progress in the same record, and does not
reuse the foreground remote cursor. Before producing candidates, the coordinator loads a lightweight
high-water timestamp index of at most 1000 entries, so sessions evicted by the 64-entry snapshot LRU
are not re-queued on every startup; that index reads neither the Doc nor history. The parent thread
re-reads the snapshot checkpoint before creating the Worker and the Loro WASM, completing immediately
on a hit; the Worker also checks it before importing cached data. All windows of the same
workspace share a `[workspaceId, roomId]` cache scope, so a slower write on the same plane cannot
lower the checkpoint. The receiving side creates no business fields; the local adapter still follows
the existing version-negotiation protocol. The cloud Worker uses the same explicit Streams endpoint as
the already mounted foreground transport.

Across windows, a non-waiting Web Lock claims workspace, room, cache scope, account,
transport plane and cloud destination before checking the cache and starting a Worker.
The claim remains held through the snapshot transaction and Worker termination; a
contender or an unavailable lock skips optional prefetch. Window destruction releases
its claim and child Worker. An explicit `ready` message precedes `start`: a module
Worker can dispatch messages while its top-level WASM initialization is still pending.
Sending `start` immediately can lose it before the handler exists.

Cache refusal returns `cache_rejected`, never `synced` or a high-water timestamp.
A separate bounded IndexedDB index remembers the same claim/activity for thirty
minutes across windows and restarts; the coordinator also suppresses reseeds within
its runtime. New activity bypasses the refusal. Expiry permits retry on a later
scheduling edge, without a polling timer. Up to 1,000 refusal records are retained;
if that metadata write fails, the runtime keeps a bounded memory fallback. That
fallback cannot provide rejection persistence to other windows or after reload.
Foreground opening still cancels prefetch and uses the existing merge/sync path.
The 128 MiB/64-entry snapshot cap is unchanged. Cache clearing includes this index.

This keeps the published Promise Repo/transport consumer boundary from the
[rollback decision](../simplification/2026-10-19-repo-upgrade-without-consumer-migration.md).
Introducing another consumer kernel would expand this download-admission fix;
the browser lock owns cross-window exclusion, which an in-process semaphore cannot.

A cache read that does not answer cannot retain the renderer slot after cancellation:
read results are abandoned without starting a Worker. Refusal metadata opens retire
on cancellation and close any late database handle without starting a transaction.
An active refusal write is aborted at the IndexedDB transaction itself; its terminal
`abort` or `complete` event, rather than a waiter timeout, releases the claim.

Task cancellation terminates the Worker from the parent thread and sends a local peer detach; this
does not depend on a Worker that is executing synchronous WASM handling a cancel message. Opening the
target session cancels the corresponding background task first, and the existing UI store takes no
part in prefetch. Importing the cache uses a CRDT merge, preserving unuploaded foreground edits. Cache
clearing covers both the snapshot and the high-water database. The now-obsolete warm/evict ports and
the `maxWarmDocs` policy field are deleted; the Worker releases its Doc at the end of a task, and the
on-disk snapshot is governed only by the capacity cap.

A large document's local sync emits `joined` first and then sends update chunks, so the adapter's
initial-sync signal alone cannot be the cache-completion condition. The Worker waits until its own
version reaches `joined.serverVersion` before exporting the snapshot, avoiding an early cancellation of
the remaining chunks and an incorrectly saved activity progress.

This complements the read boundary of the [single history writer](2026-09-07-single-history-writer.md):
background prefetch bypasses the Mirror entirely, while user business writes remain the original
HistoryWriter's responsibility. The current guarantees are written into the
[draft Spec](../../../../specs/session-background-prefetch.zh.md).

## Verification and limits

The [worker suite](../../../../packages/components/tests/eager-sync-worker.test.ts) uses
real CRDT updates, delays the final local chunk, checks refused/failed cache writes,
and merges remote history without losing unsent foreground edits. The
[coordinator suite](../../../../packages/components/tests/background-sync-coordinator.test.ts)
checks bounded candidates, environment gates, rejection without false high-water,
new activity and event-driven expiry. The
[browser acceptance](../../../../packages/components/tests/eager-sync-browser.integration.mjs)
uses actual Chromium windows, Workers, HTTP downloads and IndexedDB to check claims,
committed cache reuse, cancellation, owner-window closure and durable rejection.
Refusal is injected after downloading synthetic bytes rather than allocating a
128 MiB history; no real conversation fixtures or production traffic measurements
are involved. Browser storage partitioning bounds sharing; separate profiles,
origins or Electron partitions do not share these claims. Installed desktop/mobile
acceptance and real long-conversation memory/performance remain separate.
