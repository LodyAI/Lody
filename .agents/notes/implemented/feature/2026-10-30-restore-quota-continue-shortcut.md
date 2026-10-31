# Restore the Claude quota continuation shortcut

Date: 2026-10-30
Status: implemented
Translation: current

[中文](2026-10-30-restore-quota-continue-shortcut.zh.md)

> The treatment of unprepared legacy reservations is superseded by the [discard decision](../bug-fix/2026-10-30-discard-unassociated-quota-reservations.md).

## Abstract

The explicit Claude quota-reset shortcut was restored for eligible owned machines while automatic Session recovery was opt-in. The failure banner now enables Session recovery instead of creating a Schedule; existing reservations retain their scheduled-message owner. Schedule and automation coordinate admission for the same failed Turn; the [legacy overlap analysis](../../proposed/bug-fix/2026-10-27-quota-recovery-legacy-schedule-overlap.md) describes the boundary.

## Decision and verification

The former shortcut created a deterministic one-time Schedule at the quota reset. The failure banner now enables the Session recovery policy for the current confirmed failure and future failures. Unassociated unprepared legacy reservations are discarded as described by the [discard decision](../bug-fix/2026-10-30-discard-unassociated-quota-reservations.md). This supersedes the [retirement decision](2026-10-27-retire-quota-continue-shortcut.md).

The automatic policy remains independently configurable; live-provider behavior remains unverified.
