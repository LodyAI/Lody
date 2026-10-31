# Restore the Claude quota continuation shortcut

Date: 2026-10-30
Status: implemented
Translation: current

[中文](2026-10-30-restore-quota-continue-shortcut.zh.md)

> The treatment of unprepared legacy reservations is superseded by the [discard decision](../bug-fix/2026-10-30-discard-unassociated-quota-reservations.md).

## Abstract

The explicit Claude quota-reset shortcut remains available for eligible owned machines while automatic Session recovery is opt-in. The shortcut uses the existing scheduled-message owner. Schedule and automation coordinate admission for the same failed Turn; the [legacy overlap analysis](../../proposed/bug-fix/2026-10-27-quota-recovery-legacy-schedule-overlap.md) describes the boundary.

## Decision and verification

The failure banner offers the shortcut with ownership, capability, failure and quota checks. It creates a deterministic one-time Schedule at reset plus one second. Unassociated unprepared legacy reservations are discarded as described by the [discard decision](../bug-fix/2026-10-30-discard-unassociated-quota-reservations.md). This supersedes the [retirement decision](2026-10-27-retire-quota-continue-shortcut.md).

The automatic policy remains independently configurable; live-provider behavior remains unverified.
