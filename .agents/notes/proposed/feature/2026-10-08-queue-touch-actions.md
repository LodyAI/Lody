# Queue touch actions

Status: proposed
Translation: current

[中文](2026-10-08-queue-touch-actions.zh.md)

## Abstract

Compact queue buttons are difficult touch targets. This change gives row actions
real 44 px boxes and a separate action line on narrow or coarse-pointer surfaces,
while retaining compact desktop layout. Browser and device acceptance remain pending.

## Decision and evidence

Shared row styles avoid overlapping invisible hit areas and apply equally to local
pending sends. Existing delivery and editing handlers remain unchanged. This extends
[local queue rows](../../implemented/feature/2026-09-28-local-queue-pending-rows.md)
under the [touch intent](../../../../specs/message-queue-touch-actions.md).
Existing queue tests cover action behavior; the 320 px story supports visual review.
