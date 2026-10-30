# Discard unassociated legacy quota reservations

Date: 2026-10-30
Status: implemented
Translation: current

[中文](2026-10-30-discard-unassociated-quota-reservations.zh.md)

## Abstract

The former Claude quota shortcut persisted a one-time `continue` without the failed Turn identity. An unprepared reservation using that original identity is skipped rather than guessed into a recovery, and its runtime state explains why it was not sent. Prepared and dispatched inputs remain under Schedule reconciliation. New manual reservations identify the failed Turn; Schedule and automation coordinate their acceptance through the existing Session Inbox so the first accepted input wins.

## Boundary

The isolated [recognizer](../../../../apps/cli/src/lib/schedules/legacy-quota-reservation.ts) requires the original workspace, Session, reset-derived ID, one-time trigger and literal complete-message payload. It recognizes a shortcut after pause or resume; ordinary messages and changed payloads or trigger times remain untouched. The [Schedule worker](../../../../apps/cli/src/lib/schedules/schedule-engine.ts) skips an unprepared run, including one waiting to retry; it never discards a prepared or delivered input. This decision supersedes the preservation of unprepared legacy reservations in the [restoration note](../feature/2026-10-30-restore-quota-continue-shortcut.md).

The UI retains access to an existing legacy reservation and uses a shared deterministic ID derived from the exact failed Turn and reset for a new one. The isolated [handoff](../../../../apps/cli/src/automations/compat/quota-schedule.ts) checks the original input and any accepted automation under the Session's Inbox gate. Schedule publishes its prepared pointer under the same gate; automation performs its final local recheck there before Inbox acceptance. The first accepted input wins, an unmatched new reservation is discarded, and ordinary schedules never enter this boundary. Previously prepared legacy work blocks only that Session's Claude quota recovery until its Schedule owner resolves it; no old input is transferred.

Stop, cancellation and release remain owned by the existing Session and Schedule paths. An unavailable automation owner leaves the affected quota Schedule retryable; a lost acknowledgement uses the existing Schedule and Inbox evidence instead of creating another input. The guarded metadata operations are local to the owner; provider queries stay outside the gate. Synthetic tests cover both acceptance orders, an explicit concurrent interleaving, independent Session progress, the old discard boundary and reservation visibility. Live provider and cross-device delivery remain unverified.
