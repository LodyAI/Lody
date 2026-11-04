# Refresh long-lived server-time calibration

Status: implemented
Translation: current

[中文](2026-10-17-presence-clock-calibration.zh.md)

## Abstract

A system-clock correction invalidated a long-lived process's startup calibration,
so a newly calibrated renderer rejected every promptly delivered heartbeat from
that producer. Cloud applications now own a native calibration loop that samples
at startup and 30 seconds after each attempt. Existing integer epoch timestamps and the shared offset remain unchanged, including native
presence and token consumers. Accurate recovery requires a successful server
sample; an offline device keeps its previous estimate rather than blocking work.

## Decision and lifecycle

Issue: [#1663](https://github.com/LodyAI/Lody/issues/1663).
PR: [#1667](https://github.com/LodyAI/Lody/pull/1667). Different calibration
generations are necessary for the persistent same-machine failure; equal stale
offsets cancel when comparing newly generated heartbeats. A forward discrepancy
can reject fresh state; a backward discrepancy can extend the lifetime of future
timestamps. The fix restores clock comparison rather than loosening freshness.

The CLI starts maintenance after authentication/detection, immediately before its
service lifetime; startup failures and shutdown stop it. The React application
effect owns the renderer loop and stops it on unmount or capability removal.
Local-only compositions create neither loop nor request. `startTimeSyncLegacy`
is the sole execution door for these Promise/React entries; delete it when their
application Scopes compose `maintainTimeSync` directly. No new Service is needed.

One shared lifecycle module contains the native loop and its Legacy entry. The
loop serializes samples and repeats after 30 seconds, covering clock corrections,
slow drift and failed previous attempts. The existing fetcher bounds headers and body by five seconds and now composes owner cancellation.
It aborts its request controller on every exit, releasing unread non-2xx bodies
instead of retaining them across periodic retries.
Startup waits for the first **attempt**, preserving best-effort failure behavior.
Failures retain the previous offset, leave presence/RPC/schedules available, and
retry; diagnostics cannot stop the loop. Shutdown interrupts the loop and fetch.
Read-only HTTP has no writer/exclusive-resource handoff; an abort-ignoring late
sample is fenced from publication rather than fencing a successor application.
The owner's signal prevents a cancelled sample from overwriting a successor's
calibration. Production owners serialize samples; one-shot commands run in separate
processes. No additional request-generation state is needed. A wall discontinuity
during sampling rejects the midpoint instead of installing a calibration from mixed clock eras.

Both `getServerNow()` and native `Clock.currentTimeMillis + getServerTimeOffset()`
read the same refreshed calibration, so workspace heartbeats and Streams token
ports need no parallel correction mechanism. RPC expiry, persisted dates and
schedule instants keep integer epoch semantics.

## Alternatives and limits

No change is needed for the specific cached-offset failure in uncalibrated local
mode, but startup-only calibration leaves both correction directions permanently
wrong in cloud compositions. Periodic refresh alone restores comparability; a
one-second discontinuity watcher would only shorten recovery and has no separate
required deadline. The loop retains the first-attempt readiness callback
because the CLI already waits before publishing time-sensitive startup state.
Moving that signal into the fetcher would report readiness before the offset is
published. Removing offset would restore initial cross-device skew. Anchoring epoch time permanently to a monotonic
counter would lose suspend time on runtimes whose monotonic clock pauses; wall
correction and suspend are not universally distinguishable offline. Keeping wall
epoch time avoids that new regression.

A correction can disagree until the next 30-second refresh and its request complete;
scheduler suspension can delay this further. Offline error, slow scheduling and
unavailable time servers do not have an absolute accuracy
guarantee; no guessed zero offset, new request gate or synthetic freshness is used.
No packaged macOS/Windows suspend, real NTP correction or production endpoint was
exercised.

## Evidence

Owning shared tests use independently calibrated modules, injected wall/monotonic
clocks and the real freshness predicate for both correction directions; they also
cover failed refresh/retry, suspend with a paused monotonic clock, integer timestamps,
native token-port time, request/body cancellation, late samples and sampling-time
correction. The native workspace suite verifies its actual heartbeat adopts the new
offset without replacing its owner. The renderer suite checks calibrated state,
zero local time-server requests and cancellation when cloud capability is removed.
Deletion ablations reproduce permanent stale calibration without periodic refresh,
a half-jump midpoint error without sample-time discontinuity rejection, late
publication without cancellation checks, and an unread error body without abort.
Clocks are explicit in the cancellation test; concurrent direct-call supersession
is outside the observed ownership contract.
