# Restore the Claude quota continuation shortcut

Date: 2026-10-30
Status: implemented
Translation: current

[中文](2026-10-30-restore-quota-continue-shortcut.zh.md)

> The treatment of unprepared legacy reservations is superseded by the [discard decision](../bug-fix/2026-10-30-discard-unassociated-quota-reservations.md).

## Abstract

Restore the explicit Claude quota-reset shortcut because the experimental Session recovery UI is default-off and available only for local Sessions. The shortcut uses the existing scheduled-message owner and works for eligible owned remote machines as before. The experimental recovery policy and scheduled continuation remain separate; enabling both may produce duplicate continuations. Cross-owner arbitration remains a [proposed decision](../../proposed/bug-fix/2026-10-27-quota-recovery-legacy-schedule-overlap.md).

## Decision and verification

The composer mounts the original shortcut, including its ownership, capability, failure and quota checks. It creates the same deterministic one-time Schedule at reset plus one second and preserves existing reservations. This supersedes the [retirement decision](2026-10-27-retire-quota-continue-shortcut.md); no existing Schedule is deleted or changed.

The restored component and its behavior suite come from the branch's base. The automation policy remains independently configurable; no cross-owner exclusion or live-provider verification is claimed.
