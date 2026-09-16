# Pace cloud sync reconnects past the Convex client's 16s ceiling

Status: implemented
Translation: current

[中文](2026-09-16-cloud-sync-reconnect-backoff.zh.md)

## Abstract

A two-hour proxy/network failure made the daemon open ~450 cloud sync WebSockets,
about 40 per 10 minutes from the first minute to the last, because the Convex
client's reconnect backoff is hardcoded to a 16s ceiling (±50% jitter → 8-24s)
and never grows further. The client exposes no knob for those constants but does
accept a `webSocketConstructor`, so a new gate (`cloud-sync-reconnect.ts`) hands
it a socket that defers the real connection until the gate's own backoff — flat
for the first six failures, then 15s doubling to a 5-minute ceiling with ±20%
jitter — allows it. The ceiling is safe only because it is not the only way back:
Streams data-plane health, already an unthrottled "we are online" edge inside the
daemon, releases a held connection at once, throttled to one forced attempt per
minute so a flapping transport cannot become the next storm. The main residual
limit is that a daemon with no Streams transport attached has no online signal
and falls back to the 5-minute ceiling alone.

## Problem and evidence

`~/.lody/logs/2026-09-16.log.1`, 04:50-06:50 UTC:

```
$ grep -c "Creating WebSocket" 2026-09-16.log.1
450
# per 10-minute bucket: 15, 34, 38, 41, 39, 36, 37, 40, 40, 41, 40, 40, 4
# inter-arrival: n=444 min=0.76s max=23.99s median=15.18s, ~uniform over 8-24s
```

Outside the window the same line appears about once per hour, so steady state
was never the problem. The 8-24s band is the fingerprint of
`convex/browser/sync/web_socket_manager`: `defaultInitialBackoff = 1s`,
`maxBackoff = 16e3`, `jitter = actualBackoff * (Math.random() - 0.5)`, with
`retries` reset only when a message arrives that has synced past the last
reconnect. The socket itself is the CLI's proxy-aware `ProxiedWebSocket`
(`lib/loro/doc.ts` installs it globally), which is why the log line is tagged
`[loro:websocket]` even though the connection is the Convex control plane
(`wss://…/api/1.33.0/sync`), not Loro Streams.

Same window, same root cause, different module: `[pr-poller] Initial meta sync
not confirmed … within 60s; retrying in 60s` repeated 345 times and PR polling
never initialized.

## What was decided

**Where the fix goes.** `ConvexClient`'s backoff fields are instance properties
of an internal manager, not options; patching them would mean reaching into
`webSocketManager`. `webSocketConstructor` is the supported seam, and pacing
there composes with the client's own loop instead of replacing it: short blips
still recover on the client's fast base delay, and only sustained failure reaches
the new ceiling.

**The curve.** Six grace failures (~45s of the client's own curve) add nothing;
after that 15s doubles to 300s with ±20% jitter, matching
`computeLoroReconnectDelayMs`'s jitter fraction. Five minutes turns the observed
outage into ~30 attempts instead of ~450 while bounding the no-signal worst case
at one wasted five-minute window. A shorter ceiling keeps attempts in the
hundreds; a longer one saves little, because the remaining cost is that single
window rather than the attempts.

**Recovery, not just quiet.** The risk this change creates is a slow return, so
`notifyOnline` releases a held connection immediately; `lody-fleet.ts` feeds it
`documentManager.onStreamsOnline`, the same cheap rising edge that already
releases parked Flock work. The floor is counted between *forced* releases, not
between attempts: an earlier version counted any attempt, which silently refused
the first genuine recovery signal when it arrived less than a minute after the
failure that started the hold. The failure streak is deliberately not cleared by
a signal — if the forced attempt fails too, backoff resumes where it left off.

**Accounting.** A connection resets the streak only after it holds for 5s, the
flap-aware rule `loro/connection-recovery.ts` already uses; an open that dies
inside the window charges the attempt instead. At most one deferred connection
exists at a time: the Convex client abandons a socket (60s server-inactivity
timeout) without closing it before constructing the next, so without superseding
the older deferrals they would all fire at the same deadline and reconnect in a
burst. A superseded socket stays silent; a `close()` on a held socket — including
at shutdown, where `dispose()` runs before `subscriptionClient.close()` — emits
the close event the client is waiting for.

## Alternatives considered

- **Reach into `client.webSocketManager` and raise `maxBackoff`.** One line, but
  it depends on a private field of a vendored client and would silently stop
  working on upgrade, with a reconnect storm as the failure mode.
- **Probe the network from the gate** (periodic HTTP to the cloud host) instead
  of consuming a signal. It replaces WebSocket attempts with HTTP attempts at
  the same cadence and proves less: the Streams edge already means real traffic
  succeeded.
- **Hook every successful CLI HTTP response** (`utils/http-transport.ts`) as an
  online signal. It is the most general signal and would cover daemons with no
  Streams transport, but it puts an observer on every request in the process for
  a case the ceiling already bounds. Deferred, not rejected.

## Deferred: higher-level retries during the same outage

The PR poller's initial-sync wait is a fixed 60s wait plus a fixed 60s retry per
workspace, so a two-hour outage costs it 345 log lines and no progress. It is
correct but uninformed: it retries on its own clock while the transport it is
waiting for knows it is offline. The shape that fits the repository is the one
`task-automation-workspace.ts` and `review-automation-workspace.ts` already use
— park the work, arm no timer of its own, and release on `onStreamsOnline` —
with a long safety interval behind it. That change belongs to `pr-poller/` and
its own spec (`specs/pr-status-reconciler.md`) and is left out of this PR
deliberately; it is a recommendation, not a decision.

## Verification and limits

`apps/cli/src/lib/cloud-sync-reconnect.test.ts` drives the gate the way the
Convex client drives it (one socket at a time, a new one only after the previous
closed, failures reported a second after the attempt reaches the network) under
fake timers: a simulated two-hour outage stays under 45 attempts with every
post-grace gap above a minute, an online signal mid-hold connects in the same
tick, 300 flapping signals force at most five extra attempts, a 1s-lived
connection charges the streak while a 5s-lived one clears it, abandoned
deferrals never reach the network, and both `close()` and `dispose()` settle a
held socket.

Not verified: no end-to-end run against a real outage, and the Convex client's
own loop is exercised only through the model of it encoded in the test harness.
If upstream changes when it constructs sockets, the harness — not production —
is what goes stale first.

Contract: [specs/cloud-sync-reconnect.md](../../../../specs/cloud-sync-reconnect.md).
Related: the same flap-aware accounting on the content plane,
[reconnect storm repro](../../../../apps/cli/tests/reconnect-storm-repro.test.ts)
and `apps/cli/src/lib/loro/connection-recovery.ts`.
