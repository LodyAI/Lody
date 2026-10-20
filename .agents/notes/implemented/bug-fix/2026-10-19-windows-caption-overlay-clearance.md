# Clear the Windows caption buttons with a measured inset

Status: implemented
Translation: current

[中文](2026-10-19-windows-caption-overlay-clearance.zh.md)

## Abstract

On Windows the OS draws the minimize/maximize/close buttons above every web
layer, and the full-window Mermaid viewer put its zoom and close controls
directly under them. Avoidance was a hard-coded `144px` that each surface had
to remember, and the viewer only reserved the device safe area, which is 0 on
desktop. The renderer now reads the caption strip from Electron's Window
Controls Overlay as `--window-caption-height` and `--window-caption-inset-right`.
Shared headers pad by its width, and the Mermaid viewer starts its bar below
it. Both values are 0 wherever there is no overlay, including native
fullscreen, so any surface can reserve them unconditionally.

## Decision and evidence

`titleBarOverlay` turns on Window Controls Overlay, so `env(titlebar-area-*)`
describes the part of the strip left to the page. The caption inset is
`100vw - x - width`. A probe of Electron 44 with `titleBarOverlay` (on Linux,
which shares the Chromium implementation) returned height 36 and an 887px
title-bar area in a 1000px window. In fullscreen, `windowControlsOverlay.visible`
was `false` and the variables were undefined, so the 0 fallbacks apply without
any JS gating. Headers keep `useWindowsCaptionPadClass` and add a 0.5rem gap
to the measured width. The image viewer keeps its in-strip bar and now reads
the same variables.

Full-window overlays clear the strip vertically, with
`max(safe-area-top, caption height)`, instead of sharing it. They have no
header row that could hold the buttons. Keeping the viewer's ✕ off the OS ✕'s
row also separates closing the overlay from closing the window.

Rejected alternatives:

- Shifting all right-side content down wastes 36px and breaks the row
  alignment of [the caption centerline](2026-09-23-windows-caption-centerline.md).
- Redefining `--safe-area-top` on Windows moves 19 consumers that assume 0
  on desktop.
- App-drawn caption buttons lose Windows 11 Snap Layouts.

Dialogs are centered with an inset of at least about 40px, so their tops
never reach the 36px strip.

## Verification and limits

An audit run of the built desktop forced the Windows overlay branch on Linux.
It used a temporary patch that was not committed. The run hit-tested every
interactive element against the overlay rect. Session, chat landing, archive,
schedules, terminal and right panels, Settings, the command palette and the
Mermaid viewer showed no overlap after the change. The viewer's controls now
sit at y=36–80.

One finding is separate and unfixed. With both sidebars open below about
840px of width, the panel minimums exceed the window and the right panel
overflows its edge by about 20px. That pushes its toggle under the strip, and
on every platform it clips the panel. Real Windows caption widths were not
measured on Windows itself.
