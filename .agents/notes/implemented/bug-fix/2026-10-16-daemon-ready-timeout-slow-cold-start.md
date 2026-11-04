# Size the daemon readiness timeout for slow cold starts

Status: implemented
Translation: current

[中文](2026-10-16-daemon-ready-timeout-slow-cold-start.zh.md)

## Abstract

`lody daemon start` and the remote upgrade handoff gave the new watchdog's Worker
a fixed 30 seconds to reach ready. On a slow Linux machine the next release took
about 40 seconds to cold-start. Every remote upgrade installed successfully, then
timed out. The launcher killed the replacement and restarted the old version, so
each retry repeated the restart cycle. The limit is now a three-minute hang
backstop. Watchdogs already running an older release still apply their 30-second
limit to the handoff they perform. Those machines need one manual restart with
the fixed release.

## Decision

The readiness handshake already ends on real failures. A non-retryable Worker
exit produces an `error` report, and a runner that dies closes the readiness pipe.
So the timeout only covers a launch that keeps running but never becomes ready.
It must cover slow hardware, cold module loading, startup network calls, and
retryable-startup backoff. Most importantly, a handoff that times out discards a
working upgrade. Three minutes is several times the observed cold start. It still
bounds a hung launch for both the interactive `daemon start` and the handoff.

Rejected alternatives:

- **Progress-based deadline over the fd 3 channel.** The runner sees the Worker's
  `startupStage` only after the Worker's local IPC server starts. That happens
  after the time-sync wait and most of the cold start, so early progress cannot
  be observed. Adding progress lines would also need an opt-in. A parent from an
  older release accepts only the first JSON line. It would reject the progress
  line as an invalid report and drain a healthy replacement.
- **Environment override of the timeout.** A remote handoff inherits the old
  watchdog's environment, so users have no practical way to set it. It would also
  add a hidden configuration surface for what should be a correct default.

The upgrade log showed `startup.sync_time` at about 20 seconds. That span starts
when startup begins and runs alongside authentication and CLI detection. Its
fetch aborts after 5 seconds once the event loop is free. So the 20 seconds likely
reflects a busy startup, not a slow time server. This change leaves the
time-sync order unchanged.

## Verification and limits

`daemon-shared.test.ts` covers both cases with fake timers. A runner that reports
ready after 45 seconds is kept alive. A runner that never reports is terminated
with its Worker and reported as `timeout`. With the old 30-second value, the
slow-start case fails. No real slow device was exercised. The fix cannot change
the limit inside watchdogs already running older releases; see the
[CLI recovery steps](../../../../apps/cli/README.md#daemon-upgrades-and-autostart).
Related decision: [verified upgrade installation](2026-10-03-daemon-upgrade-installation.md).
