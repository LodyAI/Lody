# Queue touch actions

Status: draft
Translation: current

[中文](message-queue-touch-actions.zh.md)

## Scenario

On a narrow screen or coarse pointer, a reader needs to edit, steer, remove,
retry or cancel a queued message without tapping adjacent controls.

## Behavior

At viewport widths up to 600 px or with a coarse pointer, queue rows are dense
single lines at least 36 px tall, and each row's actions sit in one More button
whose real box is at least 40 × 36 px. Boxes never overlap a neighbouring row's,
so the row height is the touch target height; the queue is secondary to the
conversation and keeps its rows compact rather than meeting the 44 × 44 px
platform guideline. Actions stay on the message line, vertically centered with
the text, rather than a detached line. Fine-pointer desktop controls stay compact.
Delivery, edit, reorder and capability rules are unchanged.

## Evidence and limits

[Queue styles](../packages/components/src/components/sessions/message-queue/surface.ts)
apply to accepted and local-pending rows. Existing queue suites exercise their
actions; the existing 320 px Storybook state supports visual review. Browser geometry
and physical-device touch comfort remain unverified.
