# Quota recovery and retained legacy reservations

Date: 2026-10-27
Status: proposed
Translation: current

[中文](2026-10-27-quota-recovery-legacy-schedule-overlap.zh.md)

## Abstract

A scheduled Claude `continue` and Session automation can target the same interrupted work. The [implemented handoff](../../implemented/bug-fix/2026-10-30-discard-unassociated-quota-reservations.md) identifies new reservations by failed Turn and uses the Session Inbox to accept at most one input. Unprepared legacy shortcuts without that identity are discarded; prepared and dispatched legacy work remains with Schedule. The implementation has synthetic coverage but still needs live-provider and cross-device verification.

## Boundary and remaining verification

The old shortcut's ID names the workspace, Session and five-hour reset, but not the failed Turn. It cannot by itself prove which failure it belongs to. Ordinary or edited schedules and already accepted inputs must not be discarded based only on the text `continue`.

New shortcut IDs include the failed Turn and reset. Schedule handoff and automation admission use the same per-Session gate; after one input is accepted, the other is discarded or rejected. A prepared or dispatched legacy shortcut blocks only the same Session's Claude quota recovery until the Schedule owner resolves it. Stop, cancellation, uncertain submissions and existing scheduled-message ownership remain with their current owners. Enabling recovery applies to future observations and does not replay a previous failure.

Tests cover both acceptance orders, a concurrent interleaving, independent Session progress, and unassociated old shortcuts. Provider behavior, remote-machine operation and actual end-to-end recovery remain unverified.
