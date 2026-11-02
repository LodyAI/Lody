# Streams live-read spin after a local persistence failure

Status: proposed
Type: bug-fix
Translation: current

[中文](2026-10-19-streams-read-loop-spin.zh.md)

## Abstract

After updating to 0.107.1, desktop users saw "reconnecting" often and then a CLI that never answered again until the app was quit. The cause is an
infinite microtask loop in the Streams live-read loop, entered when saving
synced data to `repo.sqlite3` fails with `SQLITE_BUSY`. Three upstream defects
combine: a retried read keeps the already-aborted request controller, the SSE
reader reclassifies that abort reason as a retriable network error, and the
aborted-request branch retries without a new controller or backoff. A
deterministic reproduction on the published packages spins the same way with
the 0.106 stack, so 0.107.1 made the trigger frequent rather than adding the
loop. Two upstream fixes are merged: loro-streams#429 fixes the loop, and
loro-repo#159 stops lock waits from freezing the event loop. Both pass new
regression tests that fail without them. Lody now logs which processes hold
`repo.sqlite3` open when a lock failure is reported, because the holder is
still unknown.

## Evidence from the report

One 0.107.1 log bundle covers two days. The included 0.106.0 portion has no
`database is locked` lines; the 0.107.1 day has 197. Each failing episode on
0.107.1 has the same order:

1. The daemon's main thread is blocked for 5.0–5.7 s (once 10 s) at low CPU.
   `better-sqlite3` waits synchronously for the 5,000 ms `busy_timeout`, then
   loro-repo persistence fails with `SQLITE_BUSY`. The desktop's 800 ms state
   probe times out, so the UI shows reconnecting.
2. `sse flush chain error` / `live read failed (flush chain)` follow for the
   meta, document and Flock rooms, so those rooms enter `error`.
3. About one second later, a stall profile with `idle=0%` names
   `awaitSseRelease ← readFromOffsetSseItems ← runReadLoopIterations`, plus
   `classifyFetchError`. After that report the main thread writes no more log
   lines. The 60 s figure is only when the watchdog reported; the thread never
   recovers. Local IPC connections are then refused until SIGKILL.

Nine of the ten app restarts on the 0.107.1 day came after such a permanent
stall; the other restart was a graceful quit.

## Mechanism (reproduced)

The reproduction uses the published packages, Node's real `fetch` and a
loopback SSE server. A `beforeRemoteCursorSave` hook throws a `SqliteError`
once, as loro-repo's durability barrier does under lock contention.

1. The flush chain calls `abort(flushError)` on the live request controller.
2. The read loop classifies the error as `internal`, logs it as terminal and
   schedules its self-restart after the 1 s floor.
3. Meanwhile undici errors the SSE body with that same object.
   streams-client's SSE reader records the failure as a `fetch` boundary
   without `abortKind: "caller"`. `thrownToStreamError` maps it to
   `network_error` with the object as `cause`. streams-crdt's
   `toTransportFailure` returns the same object and replaces its recorded
   context with `originalCode: "network_error"`.
4. The self-restart runs `state.requestController ??= new AbortController()`
   and keeps the aborted controller. `awaitSseRelease` rethrows the stored
   reason synchronously; it now classifies as retriable `network`.
5. The aborted-request branch ("rejoin() abort or retriable flush") resets the
   attempt count and `continue`s without a new controller or a sleep. No
   request is sent and no timer runs again.

A consumer `rejoin()` replaces the controller. In the reproduction a rejoin
500 ms after the failure recovers the room; at 1,500 ms it never runs. Lody's
workspace reconnect calls `rejoin()` on errored rooms, but its observed delays
were 0.8–1.1 s on the first attempt and 1.7–4.6 s afterwards. Each errored room
therefore races its own 1 s restart.

## Upstream fixes and validation

All three defects are in loro-streams. Each patch was applied to a scratch copy
of the published bundle and run through the same reproduction:

| Bundle                                        | `SqliteError` from the hook                    | Retriable 503 from the hook | Abort without reason |
| --------------------------------------------- | ---------------------------------------------- | --------------------------- | -------------------- |
| streams-crdt 0.17.0 + streams-client 0.9.0    | spins after 1 s                                | spins at once               | spins at once        |
| streams-crdt 0.19.0 + streams-client 0.12.0   | spins after 1 s                                | spins at once               | spins at once        |
| fresh controller at loop entry only           | recovers                                       | spins                       | spins                |
| aborted branch swaps controller and backs off | recovers                                       | recovers                    | recovers             |
| both changes                                  | recovers                                       | recovers                    | recovers             |
| caller-abort classification only              | no spin, but stays `error` with no new request | not run                     | not run              |

Merged upstream change,
[loro-streams#429](https://github.com/loro-dev/loro-streams/pull/429)
(on `main` at `0900fca1`):

- streams-crdt `transport-runtime.ts:runReadLoopIterations` replaces an aborted
  `requestController` on entry. In the aborted branch, when the controller is
  still the captured one, it installs a fresh controller and uses
  `awaitReadRetryBackoff`. A `rejoin()` abort has already swapped the
  controller and keeps its immediate restart.
- streams-client `sse.ts:readSseEvents` records a body read that fails after
  the caller aborted as `abortKind: "caller"`, matching the existing rule that
  explicit cancellation is not `network_error`.
- Regression tests reproduce Undici's behavior of erroring an aborted body
  with the abort reason. They use fake timers and a guard that closes the
  transport when reads repeat without a request. The three streams-crdt cases
  in `self-healing-loops.test.ts` and the caller-abort case in streams-client
  `error-context.test.ts` fail before the patch and pass after it. The full
  package suites pass (streams-crdt 510, streams-client 206). The read-loop
  change alone passes the loop tests. With the provenance change alone, the
  room stays in `error` and sends no new request.
- The built patch also recovers in every loopback scenario that uses real
  `fetch`.

Lody adopts the fix by pinning streams-crdt 0.19.1 and streams-client 0.12.1
in the `pnpm-workspace.yaml` catalog, with matching reviewed
`minimumReleaseAgeExclude` entries. One catalog bump covers the CLI and the
renderer, which uses the same live loop. loro-repo's peer range already accepts
0.19.1, so its resolved peer moves too.
Durable rooms in Lody, both in the 0.107 stable branches and on `main`, use the
Promise `StreamsCrdt` through `loro-repo/transport/streams`. The only
`@loro-dev/streams-crdt/effect` import is the presence (ephemeral) stream, and
the stable builds do not import `loro-repo/effect`. So the fix covers every
durable room Lody runs.

## Lock waits without freezing the event loop

[loro-repo#159](https://github.com/loro-dev/loro-repo/pull/159) changes
`SqliteRepoStore`. After opening, a connection it owns uses `busy_timeout = 0`.
Every storage call then runs through one ordered lane. A section that hits
`SQLITE_BUSY` is retried with an asynchronous backoff until `busyRetryMs`
(default 5000 ms, the old bound) after it was requested, then rejects with
the driver's error. Later work queues behind it, so request order and the
"data commits before its cursor" rule hold. `PersistenceWriter` fails a busy
shared commit once instead of retrying each group alone.

- **Why the storage layer.** The failing dirty-document flush calls
  `storage.save` directly and never passes through `PersistenceWriter`, so a
  retry there would miss it.
- **Compatibility.** Opening and `recoverStaleWriter` keep their synchronous
  5000 ms wait. A caller-supplied `database` keeps `busy_timeout = 5000`.
  `close()` rejects work that is still waiting.
- **Tests.** A second connection holds the write lock and the tests use fake
  timers. Without the change, the ordering test blocks for 15 s (three calls
  of 5 s each) and fails. The close and `PersistenceWriter` tests also fail.
  The budget test is a contract that passes on both. The full `pnpm check`
  passes (651 tests), as do build, package and writer-recovery checks.
- **Alternative deferred.** Moving SQLite work into a worker would also take
  CRDT CPU work off the main thread. The owner deferred it for now.

Lody needs only the version bump: `createCliSqliteRepoStore` opens its own
connection, so it gets the new defaults. This change pins loro-repo 0.23.3
with a matching reviewed `minimumReleaseAgeExclude` entry.

## Naming the lock holder

`apps/cli/src/lib/loro/sqlite-lock-diagnostics.ts` observes the
`database is locked` reports that loro-repo and streams-crdt print. It then
runs a read-only `lsof +c 0 -F pcR` on each workspace's `repo.sqlite3`, WAL
and SHM files, through the shared process layer with a 5 s timeout. One warning
per database names every other opener's pid, parent pid and command. Probes are
limited to one per minute and one at a time, and they never retry, block or
touch storage. `lsof` lists openers, not the lock owner. Without `lsof`
(Windows) the line records that openers are unknown.

## Unresolved limits

- **Lock holder unknown.** Inside the daemon, `repo.sqlite3` has exactly one
  connection, and loro-repo's SQLite transactions are synchronous, so the daemon
  cannot hold the lock across a wait. Neither the desktop nor the MCP host opens
  the file in 0.107. One-shot CLI commands do open it (see
  [Flock persistence migration](../../implemented/architecture/2026-09-27-loro-repo-flock-persistence-migration.md)),
  but their logs are not in this bundle. Capture the openers with `lsof` on
  `repo.sqlite3*` during an episode.
- **Lock hold time unchanged.** loro-repo still replays CRDT data inside
  IMMEDIATE transactions on loads and some snapshot merges. That keeps both
  the main-thread CPU cost and how long each process holds the lock for
  others.
- **Validation scope.** Both fixes are verified by upstream tests and a
  loopback reproduction, not on the reporter's machine. The 0.106 comparison used the same synthetic trigger,
  not the reporter's workload.
