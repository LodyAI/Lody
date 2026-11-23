# Recover interrupted local Loro room joins

Status: implemented
Translation: current
Related: [中文](2026-09-17-local-loro-join-recovery.zh.md)

## Abstract

A local Loro room could remain in `connecting` or `reconnecting` after a join
send failed or its reply never arrived, leaving the workspace retry supervisor
without an actionable error. The adapter now owns each connected join attempt's
120-second deadline and changes recoverable failures to `error`, which lets the
existing bounded supervisor backoff retry it. Flock reconciliation is included
in that attempt boundary, so an import failure cannot falsely publish readiness;
this addresses a deterministic recovery gap, not a proven cause of a past
network incident.

## Decision

The Electron relay remains responsible for socket reconnection. The workspace
supervisor remains the sole room retry owner: adapter failures publish `error`,
while ordinary `connecting` and `reconnecting` states remain excluded from
immediate retry. A request id plus sync generation guards timeout, delayed join,
and asynchronous Flock completion callbacks; closing, disconnecting, terminal
failure, or supersession cancels the pending attempt.

## Evidence and limits

Focused adapter tests cover a withheld reply, synchronous send failure, and a
rejected Flock import followed by a valid replacement join. The shared package
typecheck remains blocked by absent ACP extension workspace modules in this
checkout. No Electron restart harness or renderer-to-main retained diagnostic
record was added in this change.
