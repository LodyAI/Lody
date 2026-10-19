# Queue touch actions

Status: draft
Translation: current

[中文](message-queue-touch-actions.zh.md)

## Scenario

On a narrow screen or coarse pointer, a reader needs to edit, steer, remove,
retry or cancel a queued message without tapping adjacent controls.

## Behavior

At viewport widths up to 600 px or with a coarse pointer, queue action buttons
have real, non-overlapping boxes at least 44 × 44 px. Actions use a separate line
so message text keeps its reading width. Fine-pointer desktop controls stay compact.
Delivery, edit, reorder and capability rules are unchanged.

## Evidence and limits

[Queue styles](../packages/components/src/components/sessions/message-queue/surface.ts)
apply to accepted and local-pending rows. Existing queue suites exercise their
actions; the existing 320 px Storybook state supports visual review. Browser geometry
and physical-device touch comfort remain unverified.
