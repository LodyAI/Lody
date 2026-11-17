# Move session prefetch into a serial Worker

Status: implemented
Translation: current
PR: [#2854](https://github.com/LodyAI/Lody/pull/2854), [#2853](https://github.com/LodyAI/Lody/pull/2853)

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
directly, but the transport adapter depends on document version vectors, so this keeps a real Doc inside the Worker. Cloud prefetch uses the published Streams `catchup()` operation rather than joining a writer room; restored cache operations must never be inferred as local uploads. It does not share the
renderer's Repo database, avoiding two independent instances writing the same persisted state.

The Worker entry installs its message handler before importing the WASM task module, preserving an immediate start message during initialization. The Worker exits at the end of each task; both concurrency and batch size are 1. The cooldown between
batches is 1.5 seconds on desktop/web and 3 seconds on mobile. The separate cache is capped at
128 MiB / 64 entries. Snapshot, snapshot version vector, activity progress and the
optional version-1 cloud checkpoint are committed in one IndexedDB row. The cloud
cursor is task-local until this final commit. It resumes only the exact stream URL
and only when both the snapshot vector and restored document cover its lower bound.
Old rows need no schema upgrade: absent or invalid cursors use bootstrap, and LRU
eviction removes data and progress together. The Worker never opens foreground
persistence. A failed task retains the previous complete pair; incomplete imports
cannot certify successful activity. One-shot catch-up returns its dependency failure;
the parent also terminates stalled tasks at the twenty-second deadline. Before producing candidates, the coordinator loads a lightweight
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
its claim and child Worker. The entry registers its handler before dynamically
loading the task module; there is no second readiness handshake.

Cache refusal returns `cache_rejected`, never `synced` or a high-water timestamp.
A separate IndexedDB index retains at most 1,000 retry records across windows and
restarts. Refusals back off from thirty minutes, doubling to twenty-four hours.
Network errors, incomplete catch-up and task deadlines back off from one minute;
the cap is thirty minutes with a worker checkpoint and twenty-four hours without
one, bounding repeated full bootstrap of an incomplete room. Genuine activity and
metadata reseeds do not reset deadlines or retry counters. The coordinator uses the
client's observed deadline instead of extending it on every deferred result.
Successful cache coverage clears retry state. Expiry permits one attempt on a later
scheduling edge; no polling timer is installed. If metadata persistence fails, a
bounded runtime fallback remains, but cannot retain backoff across reloads or share
it with other windows. Foreground opens remain independent. Cache clearing includes
this scheduling index; the 128 MiB/64-entry snapshot limit is unchanged.

This keeps the published Promise Repo/transport consumer boundary from the
[rollback decision](../simplification/2026-10-19-repo-upgrade-without-consumer-migration.md).
Introducing another consumer kernel would expand this download-admission fix;
the browser lock owns cross-window exclusion, which an in-process semaphore cannot.

A cache read that does not answer cannot retain the renderer slot after cancellation:
read results are abandoned without starting a Worker. Refusal metadata opens retire
on cancellation and close any late database handle without starting a transaction.
Retry metadata writes and clears have a one-second wait budget. Cancellation attempts
to abort the actual IndexedDB transaction, but a missing terminal event cannot retain
the claim or renderer queue. A task deadline gets an independent receipt budget because
the expired task signal cannot persist that receipt. A late metadata result only changes
rebuildable retry hints; the in-memory cooldown remains available. Document snapshots
still commit before Worker completion, and this finalizer never advances document progress.

Task cancellation terminates the Worker from the parent thread and sends a local peer detach; this
does not depend on a Worker that is executing synchronous WASM handling a cancel message. Opening the
target session cancels the corresponding background task first, and the existing UI store takes no
part in prefetch. Importing the cache uses a CRDT merge, preserving unuploaded foreground edits. For a cold
storage load, foreground progress can be seeded only after that merge is durable (or
already covered on disk), before Repo owns the document. Plaintext mode, workspace
scope, room and the mounted transport's stream URL must match. A covered checkpoint
is inserted only when no foreground cursor exists; offsets and timestamps cannot
order two cursors. Web Locks serialize this conditional write with ordinary saves
across callers sharing a database. Without Web Locks, adoption is skipped. Existing
live documents never adopt progress. Failure keeps ordinary bootstrap available.
The cursor records contain remote replay progress, not producer acknowledgments;
local operations outside the server lower bound still upload normally. Cache
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
real Loro and controlled HTTP for incremental restarts, pending imports, failed or
interrupted writes, 410 recovery, incomplete-room backoff across clients, and safe
merging of unsent foreground edits. The
[cold-load suite](../../../../packages/components/tests/local-window-bootstrap.test.ts)
checks persistence-before-cursor ordering, independent window databases, existing
cursors, pending imports and unsent writes reaching the remote. The
[cursor-store suite](../../../../packages/components/tests/resilient-remote-cursor-store.test.ts)
checks conditional insertion against ordinary writes through real IndexedDB.

The [coordinator suite](../../../../packages/components/tests/background-sync-coordinator.test.ts)
pins candidate and environment gates, no false high-water, and event-driven retry.
The [browser acceptance](../../../../packages/components/tests/eager-sync-browser.integration.mjs)
uses actual Chromium windows, Workers, downloads and IndexedDB for duplicate-download
exclusion, committed-cache reuse, cancellation, owner closure, authority/plane scope,
unanswered reads, persistent timeout/failure receipts and successful reset. With
controlled time, continuous new activity produces only six refused downloads in
its first twenty-four hours. Refusal is injected after downloading synthetic bytes;
it does not allocate a 128 MiB history or measure production savings.

Sharing is limited to one browser storage partition: separate profiles, origins or
Electron partitions do not share locks. Installed desktop/mobile acceptance and real
long-conversation memory/performance remain separate. No real conversation fixtures
are used. Thread isolation does not provide unlimited memory or remove contention.
