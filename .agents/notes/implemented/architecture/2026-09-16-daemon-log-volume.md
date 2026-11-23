# Separate hot-path diagnostics from the daemon's default log

Status: implemented
Translation: current
PR: [#756](https://github.com/LodyAI/Lody/pull/756)

[中文](2026-09-16-daemon-log-volume.zh.md)

## Abstract

The daemon's file transport is hardcoded to `debug` regardless of the user's console level, so every
`logger.debug` on a per-token or per-flush path is formatted and persisted, and because rotation
keeps only a 20 MB window, a few high-frequency records evict the history an investigation needs. A
`trace` level now sits below `debug`; the file sink stays at `debug` and only descends to `trace`
under `LODY_LOG_TRACE=1`. Replaying the most recent complete day (12.88 MB) through the new routing
removes 3.91 MB (30.4%); the dedicated crash, stall and exit diagnostics added to the same log are
untouched. The largest remaining consumer, the presence heartbeat's delivery diagnostics, is kept on
purpose because it is the only way to diagnose a machine that reads offline while its room reports
`joined`. The volume is not an energy concern — formatting and writing average roughly 0.15 KB/s —
this is purely about how much diagnosable history fits in the window.

## Decision

The governing rule for every demotion in this change: **before a record leaves the default sink, ask
whether its subsystem's failures remain diagnosable without it.** If the answer is no, the record
stays, or the demotion is narrowed so the anomalous path still reports at `debug`. That rule, not a
per-message volume ranking, decided each case below — including the one it kept.

`trace` is a real level rather than an environment flag per call site because the question "which
records reach the file?" then has exactly one answer, testable in one place. The console keeps
following `config.level`; the file sink resolves its own level through `resolveFileLogLevel`, which
both the transport factory and `setLevel` call, so silencing the console can never narrow the
diagnostic record.

Demoted:

- **`ACP Session started`** pretty-printed the whole `NewSessionResponse` — every mode, model,
  description and `_meta` extension — as a multi-line block per session start. It is now a one-line
  summary naming the session id and the *shape* of the advertised catalog (counts, current
  mode/model, option ids, `_meta` keys). Startup investigations read those fields; the full response
  is still dumped, at `trace`.
- **`acp.flush_updates_batch` and `history.turn_gate_wait`** run once per streamed-token flush — the
  gate wait sits in front of every flush. `startTraceSpan` and `traceAsync` gained a `hot` option
  that routes start/end to `trace`. Diagnosability is preserved where it matters: a hot span that
  fails, or that exceeds `slowMs` (default 1s), still reports at `debug`, so a stall or an error in
  the flush path remains visible without tracing enabled after the fact.
- **`Loro repo flush started`/`completed`** were a mandatory pair per flush. Measured healthy
  flushes have a p50 of 2 ms and a maximum of 39 ms. The start record moved to `trace` and the
  completion record reports at `debug` only past 200 ms. A flush that hangs instead of returning is
  still reported by the existing `withSlowOperationWarning` interval, so the failure mode these
  lines were there to catch is unaffected.
- **Local control** emitted arrival, body-size and parse records before the completion record. The
  first three moved out of the default sink, and the completion record absorbed the workspace id and
  a duration, so one line still describes a served request. The parse-failure, machine-mismatch and
  dispatch-failure branches keep their own `debug` records.

Kept, by the same rule:

- **Presence machine heartbeat `written`/`delivered`** — now 3.33 MB on the replayed day, a quarter
  of the log. These lines carry the shared presence write queue's depth, write errors, and each
  heartbeat's age when it actually leaves the process; the
  [presence diagnosis procedure](../../../docs/cli-lib-loro-presence.md) reads them from the daily log
  to explain a machine that reads offline while conversation sync is healthy, which no other record
  can. Without them that failure is undiagnosable, so they stay at `debug`.
- **Crash, stall and exit tracing** from
  [daily-log crash and stall tracing](../feature/2026-09-25-daily-log-crash-and-stall-tracing.md) —
  the Electron main-process mirror, `[process-exit]`/`[process-fatal]`, and the
  `[event-loop]`/`[event-loop-stall]` records. They were added for incident diagnosis. The Electron
  mirror and the exit and stall appenders write the daily file directly rather than through this
  logger, and the CLI-side stall records use `debug`/`warn`, so none of them is reachable by this
  change; the replay confirms no such line matches a removal rule.

`[pr-poller] Bucket empty` is deliberately untouched here; it is throttled by scope in separate
work.

## Corrections

Two statements in an earlier revision of this note were wrong and are corrected above:

- It listed `history.turn_gate_wait` as demoted, and counted it in the replay, but only
  `acp.flush_updates_batch` had been marked `hot`. The gate-wait span is now marked too.
- It demoted the presence heartbeat. After this branch was written, the heartbeat line was extended
  into the presence delivery diagnostic described above, so demoting it would now fail this note's
  own rule; the demotion was dropped when the branch was rebased.

The earlier 60.6% figure, measured against a 2026-09-16 log, included both and is superseded by the
replay below.

## Alternatives

Sampling the hot spans by time (one span per minute) was considered instead of a level. It keeps
some steady-state signal in the default log, but it makes a given turn's spans present or absent
depending on when the turn ran, which is worse for the debugging session that needs *this* turn.
Level plus a slow/error escape hatch gives a deterministic rule: healthy and fast is silent,
anything else is not.

Leaving the file transport at `debug` and gating individual call sites on environment variables was
rejected: each new hot path would invent its own flag, and there would be no single answer to what
the log contains.

## Verification and limits

Replaying `~/.lody/logs/2026-09-26.log.gz` — one complete local day, 12.88 MB and 109,864 lines,
written by a build that already contains the crash and stall tracing — through the new routing
removes 3.91 MB (30.4%), leaving 8.96 MB: Loro flush pairs 1.78 MB, hot spans 1.14 MB,
session-started dumps 0.89 MB, local control 0.09 MB. The partial following day (10.61 MB through
16:33 local) loses 4.49 MB (42.3%), mostly hot spans (2.51 MB), which scale with streaming
activity. Across both files, none of the 142 crash, stall, exit or desktop-mirror lines matches a
removal rule, and exactly one hot span escaped to `debug` for exceeding its slow threshold — the
escape doing its job.

Tests cover the file sink's level policy (default `debug`, `trace` only on an explicit
`LODY_LOG_TRACE` opt-in, unrecognized values ignored), the span routing rules including the slow and
failed escapes, and that the session summary stays single-line and bounded as the advertised catalog
grows. No test asserts the text of a product log message.

Adding `trace` to the `Logger` interface touched every test double in `apps/cli`. Most are cast with
`as unknown as Logger`, which type-checks without the new method and fails only at runtime, so the
full CLI suite, not the type check, is the evidence that none was missed.

The replay is an estimate against one machine's days: the session-started saving uses a fixed
summary size rather than the real one, the Loro saving assumes the threshold keeps healthy flushes
out (every observed flush was under 40 ms, which is not guaranteed under load), and hot-span savings
move with how much the user streams. The change does not alter the 20 MB rotation size, the 7-day
retention, or `[pr-poller]` volume. `apps/cli/AGENTS.md` still links `context/cli-startup.md` and
linked `context/cli-logs.md`, neither of which exists in this repository; the dangling logs link was
replaced by the rule itself, and the startup one is left as found.
