# Keep Code Collab refresh outside turn completion

Status: implemented
Translation: current

[中文](2026-10-21-code-collab-turn-finalization-wait.zh.md)

## Abstract

A pending Code Collab refresh could retain a completed conversation's finalizing
presence and make Stop await the same queue. Completion, failure and Stop now
schedule refresh without awaiting it. The service owns configurable finite
attempts and cancellation through scans, Git subprocesses and publication
checkpoints. Late results cannot start subsequent snapshot writes; shared Repo
I/O retains its existing owner. This fixes the demonstrated propagation without
claiming to identify the external report's underlying pending operation.

## Evidence and decision

The diagnosis used source at `a8cffe6f1be2a7b6983770afdebe5231b0a7ae10`.
Document status was already idle while execution retained finalizing presence
until refresh returned. A controlled pending pre-sync held normal completion and
cancellation behind three same-owner waiters; another owner progressed. Missing
refresh completion alone cannot locate the pending operation within workspace
resolution, scan, Flock open, flush, sync or signal publication. No local daemon
logs were used as evidence for the external report.

The [existing display decision](2026-10-06-finalizing-status-label.md) still applies:
required ACP drain and local turn evidence remain owned by the turn. Optional
file-view projection moves to the service; clearing presence before required
cleanup would not supply that separation.

## Ownership and cancellation

- Execution observes synchronous/asynchronous refresh failures at its background
  entry. A pending refresh cannot delay turn release, outcome delivery or the
  next input, on success, error or Stop.
- Refreshes coalesce by workspace owner, retaining parent-owner routing for tabs.
  Each running batch settles its own waiters; later batches neither prolong that
  wait nor inherit its error.
- Workspace resolution, executing refreshes and standalone publication/repair
  use positive `taskTimeoutMs`, defaulting to `LODY_CODE_COLLAB_TASK_TIMEOUT_MS`
  or 30,000 ms. Invalid/nonpositive settings use the default. Nested publication
  inherits refresh cancellation. This is an attempt budget, not one request
  deadline covering all earlier queued batches.
- Disposal cancels active attempts and pending waiters. Explicit owner release
  also cancels its tasks and repair timer. Intentional cancellation schedules no
  repair; timeout leaves unconfirmed publication retryable.
- A private MessagePort carries cancellation into the scan worker. Its signal
  reaches Git through the shared process facade; parallel children are joined
  before returning, including cancellation. Tinypool's thread-terminating
  `signal` option was rejected because it can abandon child process owners.
  Bun's child-process runtime uses a task-ID-scoped ready/abort IPC handshake.
  Cancellation never triggers a fresh fallback scan.
- Main-thread work checks cancellation before new work and shared-state
  replacement. Uninterruptible reads retain only attempt-local results.
  Publication checks after open/pre-sync and before writes, forwards the signal
  to Repo sync, and blocks stale notification or aggregate writes after delayed
  reads.
- Raw shared Repo/storage I/O may outlive an aborted waiter. The same Repo and
  per-stream serialized owner retain it. No replacement replica or shared room
  teardown is introduced, and already-applied CRDT data is not rolled back.
  Unconfirmed local publication preserves its pending signal and latest-state
  owner-scoped repair.

```text
turn: required history / ACP cleanup -> schedule refresh -> release presence
service: owner queue -> bounded scan -> bounded publication -> notification
                         cancellation reaches worker and Git
                         late results cannot resume snapshot writes
```

A small native Effect migration was assessed and deferred: this responsibility
still consumes Lody's Promise resolver, diff store, watcher and process facade,
plus the published Promise Repo. Replacing only the outer timer/fiber would not
complete a native unit. Locked dependencies and migration-ledger claims are
unchanged.

## Recent-version leads

The wait predates the Oct 17 SDK adoption. Publisher and scan-worker/pool source
were unchanged across that interval; #1726 added uncommitted-diff reads without
changing this queue. A shallow Git boundary cannot date the original introduction.

- #1607 upgraded Repo 0.22.0 → 0.23.0, CRDT 0.17.0 → 0.19.0 and Client 0.9.0 →
  0.12.0. Actual published clients under controlled timers confirmed ordinary
  append's default timeout changed from 10 s to 60 s. Initial-sync uploads had a
  different old policy. This explains slower failure, not perpetual pending.
- #1672/#1677 adopted Flock queue/compaction fixes. #1713 withdrew native consumers
  but retained upgraded SDKs.
- #1748 adopted CRDT 0.19.1, Client 0.12.1 and Repo 0.23.3. The
  [separate read-loop investigation](../../proposed/bug-fix/2026-10-19-streams-read-loop-spin.md)
  concerns broader daemon failure; it cannot identify a responsive daemon's stuck
  owner queue without matching build/log evidence. Source merge is not installation.

## Verification limits

Behavioral regressions cover turn release and next input with pending/rejected
refresh, Stop with pending refresh, configured expiry followed by newer queued
state, late publisher failure, disposal, stale pre-sync results and cooperative
worker cancellation with real Git-child reaping. Existing publication/file RPC
coverage is retained. Tests use explicit gates and fake timers.

The targeted suites pass 377 cases. The emitted worker and production pool pass
cancellation, Git reaping and next-task smoke in thread and child-process modes.
CLI bundling under a 2048 MiB heap, type checks, formatting, static boundary checks
and documentation checks pass. Full components pass 5,882 cases, Shared 1,580,
E2EE Core 432 and Electron 26. The CLI full run has 4,461 passes, four skips and
one failure in the unchanged recursive native-SSH Git credential fixture
(`context_unreadable`), so `pnpm check` is not reported green. Initial loopback
permission failures were rerun with local-server permission. No deployment or original-device reproduction is claimed.
The external pending operation's underlying cause remains unknown.
