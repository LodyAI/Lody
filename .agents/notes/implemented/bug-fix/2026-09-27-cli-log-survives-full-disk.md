# Keep the CLI daemon alive when its log disk is full

Status: implemented
Translation: current

[中文](2026-09-27-cli-log-survives-full-disk.zh.md)

PR: [#1056](https://github.com/LodyAI/Lody/pull/1056)

## Abstract

When the disk holding the Lody data directory filled up, the daemon's next file
log write failed with `ENOSPC` on a stream nobody listened to. The resulting
`uncaughtException` ran cleanup and `process.exit(1)`; the cleanup flush also
failed with `SQLITE_FULL`, so in local mode every Loro change made since the disk
filled was lost, and the supervisor restarted the daemon into the same crash. The
file log transport now owns its rotating sink: a write failure drops the sink and
the lines logged meanwhile, and a fresh sink is opened once a probe write proves
space has returned. The daemon keeps its in-memory changes and flushes them when
space returns. This is only the first layer of issue #1054; disk-space detection,
user-visible warnings and a degraded mode remain open.

## Evidence

- winston-daily-rotate-file 5.0.0 hands its `fs.WriteStream` errors to
  file-stream-rotator's proxy emitter (`transport.logStream`), which nothing listens
  to. winston's `exitOnError: false` only covers handled exceptions, not transport
  stream errors.
- On a 16 MB RAM disk, a bare `DailyRotateFile` hit one `ENOSPC` and then never
  wrote again after space was freed: the destroyed stream silently discards every
  later write until a date or size rotation. Recovery therefore needs a new sink.
- The real daemon (`lody start`, local mode, `LODY_DATA_DIR` on a 256 MB RAM disk)
  at base `31fb1256` exited with `code=1` about three minutes after the disk
  filled, on `Uncaught exception in CLI: ENOSPC ... write`. With this change it ran
  for more than three minutes on the full disk and printed one stderr notice. It
  resumed the file about two seconds after space was freed and exited with code 0
  on SIGINT. A restart on the same data directory reopened the existing workspace.
- The real logger, `registerProcessErrorHandlers`, `SqliteRepoStore` and `LoroRepo`
  were run together: 10 documents were written, then the disk was filled, 200 more
  were written and 400 lines were logged. At base, the process exited 1, its cleanup
  flush failed with `database or disk is full`, and a reopen found 0 of the 200
  documents. With this change, the flush while full still failed with
  `SQLITE_FULL`, but the process stayed alive and flushed after space was freed.
  A reopen found 10/10 and 200/200 documents, and `PRAGMA integrity_check`
  returned `ok`.

## Decision

`ResilientFileTransport` (`apps/cli/src/utils/resilient-file-transport.ts`) is a
winston transport that owns a `DailyRotateFile` instead of letting winston pipe to
it. `createFileTransport` builds it for both the daemon log and the MCP HTTP host
log.

- An error on the sink's `logStream`, or a synchronous throw from opening or
  writing it, drops that sink. Listeners stay attached to dropped sinks, so a late
  error is still caught.
- While no sink is open, lines are dropped rather than copied to stderr. In the
  hybrid logger the console transport already carries info and above. The daemon
  worker's stderr is only an in-memory tail kept by the supervisor, so copying the
  debug volume there would add noise without making it durable.
- Recovery is lazy: the first log call at least 30 seconds after a failure creates
  and removes a small probe file in the log directory. It only opens a fresh sink
  if that write succeeds. This adds no timer and no background work, and a probe
  that fails keeps the same failure episode.
- Stderr receives at most one failure notice every 10 minutes. It also gets a
  resume notice when a reported episode ends. The resumed file starts with a
  warning line that records the failure time, the error and the dropped count. The
  count is a lower bound, because lines the failed stream had already accepted are
  lost too.
- `DailyRotateFile`'s own `error` events report archive and retention failures.
  Those are written as warnings into the still-open file and do not drop the sink.

The process-level `uncaughtException` handler is unchanged: every other fatal
error still exits. Only the identified source is guarded, and this change
guards it regardless of error code, since any file log failure must not end the
process.

## Scope audit

The other synchronous diagnostic writers already could not throw:
`appendDailyLogSync` (fatal and exit traces) swallows every failure. The
event-loop stall watchdog wraps its `appendFileSync` and reports `write-failed`
through the logger. No SQLite store holds diagnostics. The background daemon's
stdio are pipes, not files.

## Limits

- A foreground `lody start` whose stdout or stderr is redirected to a file on the
  full disk can still crash through Node's synchronous stdio stream. The daemon
  path does not do this.
- The unguarded `CLAUDE_AGENT_LOGS` writer in `acp-extension-claude` only runs in
  that package's standalone binary, which the CLI does not launch.
- The resume warning is written before the line that triggered the reopen but
  formatted after it, so its timestamp can be a few milliseconds later than that
  of the next line.
- Issue #1054 layers 2–4 remain open: `statfs` detection and machine health, user
  warnings for classified storage errors, a degraded mode that pauses disk-heavy
  work, and a ballast file. The loro-repo side is tracked in loro-dev/loro-repo#139.
