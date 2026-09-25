# Trace desktop, CLI exits, and event-loop stalls in the daily log

Status: implemented
Translation: current

[中文](2026-09-25-daily-log-crash-and-stall-tracing.zh.md)

## Abstract

A 0.100.0 user reported that Lody closed or disconnected on every launch. The
bundled logs could not explain it: Electron main wrote nothing to disk, CLI stalls
of 60–90 seconds named no code, and lines written just before an exit were lost.
Electron main now appends its console output, lifecycle, crashes, and embedded-CLI
supervision to the CLI's daily log. The CLI gains a watchdog thread that profiles
the main thread during a stall, plus synchronous exit and crash beacons. This adds
evidence only; it changes no restart, kill, or timeout behavior, and a native crash
still shows up only as a missing exit line.

## Problem and evidence

The report bundle (`~/.lody/logs/2026-09-24.log` and its siblings) showed:

- Every Electron-launched CLI logged repeated timer lag of 57–91 s with
  `cpuRatio≈1`, while two Homebrew daemon runs doing the same Sessions logged none.
  The lag line says a stall happened, never what ran.
- Each MCP host `host handshake timed out` followed such a stall. The timer runs
  before pending pipe I/O, so a host that had already answered was killed anyway.
  The log could not distinguish this from a broken host.
- Three desktop launches ended about 8 s after starting, each under a new parent
  PID, with no line from the CLI. Electron main's own output went only to stdout,
  and no `~/Library/Logs/Lody/main.log` exists, so why the desktop closed was
  unknowable.
- The reported "OOM" could not be verified. V8 aborts write only to stderr, which
  reached the renderer's output buffer but no file.

## Decision

One file, `<data dir>/logs/<local date>.log`, tells the whole story. Shared
`@lody/shared/node/daily-log-file` defines how external writers append to it:
the day's live rotation (`<date>.log.<n>`, else `<date>.log`), in the CLI line
format, synchronously.

Electron main (`desktop-log.ts`, installed from `desktop-bootstrap` once `userData`
is final):

- Installs fail-safe: an installation error disables the log and startup
  continues. The bundled-entry startup test runs the real install against a
  fixture data dir.
- Mirrors `console` to the file under scope `desktop:<pid>`; the terminal still
  prints. Bearer tokens and credential-like query parameters are redacted as a
  backstop only.
- Logs a start banner, `before-quit`/`will-quit`/`quit`/`exit`,
  `render-process-gone`, `child-process-gone`, power suspend/resume, main-thread
  timer lag ≥2 s, and `uncaughtExceptionMonitor`. The monitor variant leaves
  Electron's default crash handling unchanged.
- Keeps a run record in `userData`, written only after the single-instance lock.
  A record without `cleanExit` at the next launch is logged as an unclean end.
- Traces each embedded CLI: spawn (subcommand and argument count only, since
  renderer-supplied arguments may carry credentials), every stderr line, exit
  code/signal/termination kind/uptime, each Supervisor exit decision, and every
  Supervisor state transition. `reconnecting` with a live child means the CLI did
  not answer its probe, which the UI shows as a disconnect.

CLI:

- `event-loop-stall-profiler.ts`: the main thread bumps a SharedArrayBuffer
  heartbeat. A worker thread sees the heartbeat go stale (4 s), attaches with
  `inspector.Session.connectToMainThread()`, samples the CPU for 3 s during the
  stall, and appends self time, inclusive time, and the hottest stack. At most
  one profile per stall and per minute, 20 per process. Armed at the top of
  `lody start` so startup stalls count. `LODY_EVENT_LOOP_STALL_PROFILER=0`
  disables it.
- The lag monitor adds the V8 heap limit to each stall line and warns once each
  at 70/85/95% of the limit. An OOM abort then has a recorded approach.
- `process-exit-trace.ts`: synchronous `[process-exit]` lines for `lody start`
  and a `[process-fatal]` line before uncaught-exception cleanup in every CLI
  process, including the MCP host that otherwise logs to its own file.
- MCP host handshake timeouts record pid, elapsed time, and timer lateness; host
  exits record the signal and uptime.

## Alternatives

- **A separate desktop log under `~/Library/Logs`.** Rejected: bug reports and
  `lody daemon logs` read the daily log, and correlating PIDs across two files was
  exactly what failed here.
- **Asynchronous or winston-based writes in Electron main.** Rejected: the most
  important lines precede process death, where queued writes are lost.
- **Post-stall attribution only (trace spans open during the lag).** Spans cover
  only instrumented awaits, while the stalls were synchronous CPU work. Sampling
  during the stall is the only direct evidence.
- **Always-on CPU profiling.** Rejected for its constant cost. The watchdog is
  idle until a stall.
- **A separately bundled worker entry.** Rejected in favor of an eval worker. The
  three naming/format helpers are inlined via `Function.prototype.toString()`, so
  they must stay self-contained (commented in the shared module). This avoids a new
  `*-worker.js` layout contract.

## Verification and limits

- `event-loop-stall-profiler.test.ts` blocks a real main thread until the worker
  has written its profile, then asserts that the blocking code and the live
  rotation file are named. The lag-monitor and desktop-log tests use injected
  clocks.
- The profiler extracted from the Vite bundle ran under Node 24 and under
  Electron 39.5.1 with `ELECTRON_RUN_AS_NODE=1` (Node 22.22.0, the user's
  runtime). Both attached in about 30 ms and attributed the blocking frame. A
  packaged, signed macOS app has not been exercised.
- SIGKILL, V8 OOM aborts, and native crashes still write nothing themselves. They
  appear as a missing `[process-exit]` line, the Electron-side exit trace and
  stderr lines, or an unclean run record. The macOS crash report remains the
  source for native stacks.
- Several processes append to one file. Appends are line-sized and use
  `O_APPEND`; winston still owns rotation, and an external writer follows the
  live rotation it finds.
- The handshake timer can still kill a host that already answered. The trace
  makes that visible; changing the timeout behavior is a separate decision.
