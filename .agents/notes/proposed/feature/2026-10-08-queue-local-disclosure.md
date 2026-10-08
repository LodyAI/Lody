# Local queue disclosure

Status: proposed
Translation: current

[中文](2026-10-08-queue-local-disclosure.zh.md)

## Abstract

An always-expanded queue competes with conversation space. An initially expanded,
local disclosure lets the reader fold it without changing delivery or losing an
editing draft. Pending and failed-send counts remain visible; browser and device
acceptance remain pending.

## Decision and evidence

The existing disclosure primitive keeps rows mounted. Moving focus to its header
bypasses ordinary blur-save, preserving an unfinished edit. Counts subscribe to
the existing local-send projection, without shared or persisted collapse state.
This extends [local queue rows](../../implemented/feature/2026-09-28-local-queue-pending-rows.md)
and follows [queue intent](../../../../specs/message-queue.md). The owning editing
suite covers fold/reopen draft continuity and live pending/failure counts; the
folded-upload story exercises the real display.
