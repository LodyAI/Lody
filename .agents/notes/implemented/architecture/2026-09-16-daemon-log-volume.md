# Separate hot-path diagnostics from the daemon's default log

Status: implemented
Translation: current

[中文](2026-09-16-daemon-log-volume.zh.md)

## Abstract

The resident daemon wrote about 12.6 MB across 154,000 lines a day, and the file transport is
hardcoded to `debug` regardless of the user's console level, so every `logger.debug` on a per-token
or per-tick path was formatted and persisted. Because rotation keeps only a 20 MB window, a few
high-frequency records evicted the history an investigation actually needs. A `trace` level now sits
below `debug`; the file sink stays at `debug` and only descends to `trace` under `LODY_LOG_TRACE=1`.
Replaying the measured day through the new routing removes 9.36 MB of 15.45 MB (60.6%). The volume
is not an energy concern — formatting and writing average roughly 0.15 KB/s — this is purely about
how much diagnosable history fits in the window.

## Decision

The governing rule for every demotion in this change: **before a record leaves the default sink, ask
whether its subsystem's failures remain diagnosable without it.** If the answer is no, the record
stays, or the demotion is narrowed so the anomalous path still reports at `debug`. That rule, not a
per-message volume ranking, decided each case below.

`trace` is a real level rather than an environment flag per call site because the question "which
records reach the file?" then has exactly one answer, testable in one place. The console keeps
following `config.level`; the file sink resolves its own level through `resolveFileLogLevel`, which
both the transport factory and `setLevel` call, so silencing the console can never narrow the
diagnostic record.

Five sources accounted for the volume:

- **`ACP Session started`** pretty-printed the whole `NewSessionResponse` — every mode, model,
  description and `_meta` extension — averaging over 120 lines per session start and 2.67 MB/day, the
  largest single item. It is now a one-line summary naming the session id and the *shape* of the
  advertised catalog (counts, current mode/model, option ids, `_meta` keys). Startup investigations
  read those fields; the full response is still dumped, at `trace`.
- **`acp.flush_updates_batch` and `history.turn_gate_wait`** run once per streamed-token batch and
  together produced 3.91 MB/day — more than every other span combined. `startTraceSpan` gained a
  `hot` option that routes start/end to `trace`. Diagnosability is preserved where it matters: a hot
  span that fails, or that exceeds `slowMs` (default 1s), still reports at `debug`, so a stall or an
  error in the flush path remains visible without tracing enabled after the fact.
- **`Loro repo flush started`/`completed`** were a mandatory pair per flush, 1.99 MB/day, with a
  measured p50 of 2 ms and a maximum of 39 ms. The start record moved to `trace` and the completion
  record reports at `debug` only past 200 ms. A flush that hangs instead of returning is still
  reported by the existing `withSlowOperationWarning` interval, so the failure mode these lines were
  there to catch is unaffected.
- **Presence machine heartbeat** is a steady tick per workspace (0.48 MB/day). It moved to `trace`;
  join failures and room-status transitions remain where they were, and those — not the healthy
  ticks — are what a presence investigation reads.
- **Local control** emitted arrival, body-size and parse records before the completion record. The
  first three moved out of the default sink, and the completion record absorbed the workspace id and
  a duration, so one line still describes a served request. The parse-failure, machine-mismatch and
  dispatch-failure branches keep their own `debug` records.

`[pr-poller] Bucket empty` (0.28 MB/day) is deliberately untouched here; it is throttled by scope in
separate work.

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

Replaying `~/.lody/logs/2026-09-16.log.1` (15.45 MB, 172,799 lines, 02:11–18:30) through the new
routing rules removes 9.36 MB (60.6%), leaving 6.09 MB: hot spans 3.91 MB, session-started dumps
2.67 MB, Loro flush pairs 1.99 MB, presence heartbeat 0.48 MB, local control 0.32 MB.

Tests cover the file sink's level policy (default `debug`, `trace` only on an explicit
`LODY_LOG_TRACE` opt-in, unrecognized values ignored), the span routing rules including the slow and
failed escapes, and that the session summary stays single-line and bounded as the advertised catalog
grows. No test asserts the text of a product log message.

The replay is an estimate against one machine's day: it assumes every Loro flush in that log would
fall under the 200 ms threshold, which held for every observed flush but is not guaranteed under
load, and it does not model days with a different session-start rate. The change does not alter the
20 MB rotation size, the 7-day retention, or `[pr-poller]` volume. `apps/cli/AGENTS.md` still links
`context/cli-startup.md` and linked `context/cli-logs.md`, neither of which exists in this
repository; the dangling logs link was replaced by the rule itself, and the startup one is left as
found.
