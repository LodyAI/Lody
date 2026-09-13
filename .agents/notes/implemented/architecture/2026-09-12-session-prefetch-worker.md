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
on a hit; the Worker reads it once more to close the cross-window race. All windows of the same
workspace share a `[workspaceId, roomId]` cache scope, so a slower write on the same plane cannot
lower the checkpoint. The receiving side creates no business fields; the local adapter still follows
the existing version-negotiation protocol. The cloud Worker uses the same explicit Streams endpoint as
the already mounted foreground transport.

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

New deterministic tests cover: no Worker created on a checkpoint hit, a Worker created after an
activity update, serial tasks, detach on cancellation, slot release after an asynchronously routed
cancellation, Worker error/destruction, and merging a real Loro update cache with unuploaded
foreground edits. The chunking case explicitly delays the final chunk to confirm the snapshot is not
saved early. The original scheduler tests are retained; the separate policy-constant test file is
deleted because the same assertion already exists in the scheduler suite. Verification used
temporary isolated dependencies rather than a full install in a nested checkout.

Isolated verification passed 36 tests, three of which are temporary probes for IndexedDB persistence,
capacity, and cross-window checkpoint monotonicity. The Worker module's typecheck and the browser
Worker build under Vite 6.4.1 also passed. The repository-wide document check and public-boundary
check are blocked by uninitialized ACP submodules; neither a full application build nor a full
typecheck was run. The new shared subpath only re-exports existing snapshot codecs and introduces no
dependency version change.

There is no real user-conversation fixture and no real long-conversation performance test. The Worker
and the UI still share device memory and CPU, so thread isolation must not be read as unlimited memory
or complete freedom from resource contention.
