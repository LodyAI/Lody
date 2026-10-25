# Streams re-downloads a room every second while local persistence fails

Status: proposed
Type: bug-fix
Translation: current

[中文](2026-10-22-streams-persistence-failure-bandwidth.zh.md)

Release update (2026-10-23): [official SDK adoption](2026-10-23-storage-recovery-release-adoption.md) uses streams-crdt 0.19.2 and Repo 0.25.0, replacing the unreleased-dependency and temporary-patch limitations described below.

## Abstract

A desktop user downloaded about 76 GB overnight (roughly 10 GB per hour) while their
data disk was 99% full. Once saving synced state locally kept failing, each durable
room restarted its live read about once a second and re-downloaded everything after
its last saved cursor, which for a large Session transcript is the whole document.
Two upstream defects cause the loop and a third keeps a replaced replica in it; they
are being fixed in loro-streams and loro-repo, and Lody adopts them through a catalog
bump. This change fixes the Lody-side companion: a CLI whose parent pipe closed wrote
2.46 GB of daily log in five minutes and never exited. The upstream fixes are not
released yet, so the bandwidth loop is still unfixed in Lody.

Related: [live-read spin after a persistence failure](2026-10-19-streams-read-loop-spin.md),
the earlier loop with the same trigger that never sent a request.

## Evidence from the report

The order in the user's `~/.lody/logs` (0.107.0-nightly.7):

1. From 16:00 the renderer's Repo storage fails: `IndexedDB transaction aborted:
Failed to write blobs (IOError)` and `database connection is closing`. The disk
   had 3.6 GiB free.
2. From 23:59 `[streams-crdt]` repeats `sse flush chain error`, `live read failed
(flush chain)` and `local append failed` several times a second, together with
   loro-repo's `Cannot persist document "session-…": the repository has replaced
this replica`.
3. 02:09–02:14 a CLI process logs `uncaughtException: write EPIPE` 2.46 GB worth;
   the desktop process restarts three times, and each restart starts the loop again.
4. Restarting the app at 10:14 breaks the loop. The same build was installed, so
   the restart stopped the loop, not a newer version.

Per-host traffic is not retained by the user's proxy across restarts, so the
attribution of the 76 GB to these rooms is inferred from the log, not measured.

## Mechanism (from the published streams-crdt 0.19.1 and loro-repo 0.23.3)

- **Backoff reset on connect.** `setReadSubStatus("ok")` resets
  `readErrorRetryAttempt`, and the SSE open callback reports `ok` before any data
  arrives. The failure comes later, from the durability barrier that runs before the
  remote cursor is saved (`beforeRemoteCursorSave` → `repo.persistDocNow`). The
  terminal-class restart therefore always waits the 1 s floor. The retriable branch
  also clears `retryAttempt` once an SSE stayed open for 5 s, which every large
  catch-up does.
- **Applied data discarded.** The cursor advances only after the barrier succeeds,
  so the next read starts from the old offset and re-downloads updates already
  imported into the in-memory document. While storage keeps failing, every download
  is wasted.
- **Replaced replica never torn down.** `LoroRepo.unloadDoc` evicts the replica and
  asks the Streams adapter to release sessions bound to it, but `releaseDocReplica`
  returns early while the session has a `refCount` or an active one-shot sync. That
  session keeps reading into the evicted `LoroDoc`, and its barrier throws
  `StaleReplicaError` forever. Which renderer holder kept the session alive is not
  known.
- **Lody's repair loop.** The cloud reconnect loop rejoins errored cloud bindings
  with a 1–30 s backoff, and `rejoin()` resets the SDK's retry counters. Even with
  the SDK backoff fixed, that rejoin cadence would still restart downloads unless a
  rejoin keeps already-applied progress.

## Decisions

Upstream ([loro-streams#435](https://github.com/loro-dev/loro-streams/pull/435),
streams-crdt 0.19.2; [loro-repo#162](https://github.com/loro-dev/loro-repo/pull/162)
and [loro-repo#163](https://github.com/loro-dev/loro-repo/pull/163), loro-repo 0.23.4;
all open):

- Reset read backoff only after durable progress, not when a connection opens.
- When only the durable cursor save fails, keep reading and uploading. Each update is
  applied in memory once; only the durable cursor stops, and its save retries on a
  1–30 s backoff until storage recovers. The room reports `error` meanwhile, and
  `rejoin()` retries the save without reconnecting. Durable cursors still never pass
  unpersisted state. An earlier revision of #435 retried the save before every read,
  which stopped all live updates while storage failed; review rejected it.
- A first join whose cursor save fails still completes and keeps reading, but it
  reports first sync (`waitUntilSynced`, `catchup`, and so loro-repo's
  `firstSyncedWithRemote`) only after a live read reaches the remote tail. A save can
  fail between catch-up pages, and confirming then let the CLI catalog accept an
  incomplete baseline. Waiters reject on close, a terminal persistence error or an
  exhausted read budget.
- Let the consumer mark barrier errors as terminal, and make `StaleReplicaError`
  one; tear down or rebind sessions bound to a replaced replica.
- Reopen the IndexedDB connection after the browser closes it (#163). Without this,
  a renderer whose storage failed once could not persist again until it reloaded.

Lody (this change): the CLI `uncaughtException` handler runs the fatal path once.
When stdout/stderr is a pipe whose reader died, each console write raised another
EPIPE `uncaughtException` on the next tick; handling each one logged and wrote again,
a chain that starved the 5 s cleanup timer, so the process never reached
`process.exit`. The first exception is traced and later ones are only counted (one
summary line before exit), and an EPIPE is not echoed to the broken console.
`tests/telemetry-process-handlers.test.ts` writes 1,000 EPIPE exceptions and
expects two fatal lines; without the change it gets 1,000.

Not changed: the renderer could pause cloud rejoins while its IndexedDB storage
fails, but loro-repo exposes no per-room error to tell storage failures from network
failures, and wrapping the storage adapter to detect them would hide its optional
capabilities from the Repo. With the upstream rejoin semantics this is unnecessary;
revisit if they cannot keep applied progress.

## Remaining work and limits

- Bump `@loro-dev/streams-crdt` and `loro-repo` in the
  `pnpm-workspace.yaml` catalog with reviewed `minimumReleaseAgeExclude` entries once
  released.
- A full disk still stops local persistence; this only bounds the traffic and log
  volume it causes. Telling the user that storage is failing is a separate change.
- Not reproduced on the reporter's machine.
