# Discard unassociated legacy quota reservations

Date: 2026-10-30
Status: implemented
Translation: current

[中文](2026-10-30-discard-unassociated-quota-reservations.zh.md)

## Abstract

The former Claude quota shortcut persisted a one-time `continue` without the failed Turn identity. Until 2026-11-16 an unprepared reservation using that original identity was skipped rather than guessed into a recovery; that compatibility skip has since been removed because all such reservations were past due. Prepared and dispatched inputs remain under Schedule reconciliation. Previously created Turn-associated reservations identify the failed Turn; Schedule and automation coordinate their acceptance through the existing Session Inbox so the first accepted input wins.

## Boundary

The legacy recognizer and the Schedule worker's `LEGACY_QUOTA_UNASSOCIATED` skip described in the abstract were removed with the [compatibility cut](../simplification/2026-11-16-drop-pre-october-compatibility.md) on 2026-11-16: the v1/v2 shortcut reservations were all due before that date, so an id without the failed Turn is now an ordinary one-time Schedule. This decision superseded the preservation of unprepared legacy reservations in the [restoration note](../feature/2026-10-30-restore-quota-continue-shortcut.md); the [quota reservation matcher](../../../../apps/cli/src/lib/schedules/quota-reservation.ts) recognizes only Turn-associated `qc3_` reservations.

Existing reservations remain available in Schedules; the failure banner now enables Session recovery instead of creating another reservation. The isolated [handoff](../../../../apps/cli/src/automations/compat/quota-schedule.ts) checks the original input and any accepted automation under the Session's Inbox gate. Schedule publishes its prepared pointer under the same gate; automation performs its final local recheck there before Inbox acceptance. The first accepted input wins, an unmatched new reservation is discarded, and ordinary schedules never enter this boundary. Previously prepared legacy work blocks only that Session's Claude quota recovery until its Schedule owner resolves it; no old input is transferred.

Stop, cancellation and release remain owned by the existing Session and Schedule paths. An unavailable automation owner leaves the affected quota Schedule retryable; a lost acknowledgement uses the existing Schedule and Inbox evidence instead of creating another input. The guarded metadata operations are local to the owner; provider queries stay outside the gate. Synthetic tests cover both acceptance orders, an explicit concurrent interleaving, independent Session progress, the old discard boundary and existing reservation handling. Live provider and cross-device delivery remain unverified.
