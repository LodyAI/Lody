# Avoid vertical divisions in the iOS workspace

Status: implemented
Translation: current

[中文](2026-10-28-ios-vertical-division.zh.md)

## Abstract

A partly open iPhone Duo reports a full-height UIKit division region. The wide
workspace uses that current view-relative region to place navigation and content
on opposite sides, keeping the retained sidebar mounted and its stored width
unchanged. When the sidebar is collapsed, content remains on the other side.
No region means the normal layout. Each side must be wide enough to be usable.

## Evidence and limits

On the iOS 27.1 simulator, the division was 40 points wide; rotation reported a
horizontal region instead. Native code converts current view coordinates to the
WebView and republishes after document recovery; older SDKs and iOS omit regions.
This is geometry-based, not a device-specific dimension. The native side rail
also avoids division regions. Horizontal conversation folds are addressed separately in the
[mobile decision](2026-10-28-ios-horizontal-division.md); settings, other
portals and the full physical-device acceptance matrix are not covered here.
