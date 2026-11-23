# Simulator input feedback latency

Status: implemented
Translation: current

[中文](2026-10-01-ios-simulator-input-latency.zh.md)

## Abstract

Remote input can feel unresponsive even when subsequent animation is acceptable.
H.264 recovery previously waited for every in-flight picture to be acknowledged,
adding a return trip despite available receiver credit. Recovery now requests an
IDR when bounded credit/pacing permit it, and touch edges can replace stale unsent
chains only when replacement is immediately eligible. Numeric input receipts and
queue timings separate transport waiting from server buffering; they do not measure
guest execution or promise low latency on a slow network.

## Ownership and constraints

This refines the [simulator panel](../architecture/2026-09-27-ios-simulator-panel.md).
`h264-flow.ts` owns credit, dependency-safe resets and the existing one-second IDR
cooldown. An IDR can follow in-flight packets on the ordered connection; previous
packets remain charged until cumulatively acknowledged. Actual send still observes
byte/frame limits, pacing and oldest-frame age. Native corruption recovery must
always invalidate its chain, even when no replacement request is currently allowed.

At remote touch down/up, a queue older than 100 ms can be invalidated after input
forwarding. An elective reset requires immediate IDR eligibility; otherwise preserve
the valid chain. Review reproduced a regression where down requested IDR and up
dropped its replacement during cooldown, adding a nearly one-second freeze. The
eligibility guard and deterministic consecutive-edge regression cover that case.
Always forcing an IDR per input was rejected because it amplifies bandwidth use;
latest-dropping encoded deltas would violate reference dependencies.

`gateway.ts` validates optional numeric receipt IDs and strips them before native
forwarding. The shipped viewer times its own touch send and matched receipt using
one monotonic clock, bounds receipt/sample state, and clears it on disconnect. No
additional socket, authentication path, native runtime change or shared metadata.
Echoes do not attest native execution or painted response and may be skipped when
the output socket is full. Frontend diagnostics admit only the new numeric fields.

## Verification and limits

The old implementation fails the available-credit recovery regression. Synthetic
600 ms RTT coverage sends a fresh IDR at 110 ms while its predecessor remains in
flight, instead of waiting for the predecessor ACK at 600 ms before requesting it.
This proves elimination of that avoidable wait, not a measured WAN improvement.
Tests also cover stale-chain replacement, local/fresh queues, cooldown, pacing,
receiver credit, gesture forwarding without telemetry fields, matched receipts,
duplicate/unknown receipts and reconnect cleanup. Physical client click-to-visible
response and real WAN improvement still require field verification.

PR: https://github.com/LodyAI/Lody/pull/1061
