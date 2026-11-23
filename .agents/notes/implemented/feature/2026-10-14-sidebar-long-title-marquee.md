# Long sidebar session titles scroll on hover

Status: implemented
Translation: current
Date: 2026-10-14
Language: English
Other language: [中文](2026-10-14-sidebar-long-title-marquee.zh.md)

## Abstract

Long Session titles in the desktop sidebar ended at an ellipsis, hiding the part
that often distinguishes one conversation from another. Keep the compact row,
then measure title overflow on hover or keyboard focus and smoothly move only
that title through its clipped area. Horizontal pointer and wheel gestures also
let users move the full title directly, without showing a scrollbar. Short
labels stay still, and reduced-motion preferences disable the automatic
movement.

## Decision

- Measure the title against its rendered width when the row is entered or
  focused; avoid observers and work on every sidebar row.
- Scroll only when more than 8 pixels overflow. Set the travel distance and
  duration from the measured amount, and return to the original position when
  the pointer leaves or focus moves away.
- Keep the inner title at its full content width while it moves inside a clipped
  wrapper, so the trailing text becomes visible instead of moving an ellipsis.
- Support horizontal pointer swipes and trackpad/wheel movement on overflowed
  titles, including touch input; vertical movement and ordinary clicks keep
  their existing behavior.
- Enable automatic movement on desktop rows. Reduced-motion users see a
  stationary title but can still swipe it manually.
- Keep the implementation in the shared session row so Workspace and chat
  lists receive the same behavior.

## Evidence

The `Components/SessionList/Long Titles` Storybook story renders a long and a
short synthetic Session title through the real row component. Chromium showed
the long title moving across the clipped row, the existing hover card remaining
available, manual pointer and wheel movement without a scrollbar, and the short
title remaining stationary. The
shows the ellipsis before hover, the animated title after hover, and the
short-title comparison.
