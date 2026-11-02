# Reduce the workspace frame to a thin rim

Status: implemented
Translation: current

[中文](2026-10-23-thin-workspace-frame.zh.md)

## Abstract

The workspace page's 8px gutter made the canvas read as a floating card and moved every page header below the fixed macOS traffic-light centreline when the sidebar collapsed. The frame now uses the smallest spacing token as a 4px rim with a concentric 14px radius, while macOS rows inside that frame compensate for its origin and keep native window controls fixed. This restores header alignment and preserves visible clearance between controls and the page edge without adding a taller title bar. The static boot shell and real workspace continue to share exactly the same geometry.

## Geometry and ownership

`WorkspaceCard` owns the visual separation between the window ground and page canvas. Its rim is `space[1]` (4px), and its inner radius is `radius.large` (14px), matching an approximately 18px window corner after subtracting the rim and hairline. The document-safe fallbacks in `WORKSPACE_FRAME_CSS` use the same literal values so the static boot shell cannot paint the former geometry before React mounts. A visible sidebar still anchors the page's left edge; a collapsed sidebar exposes the rim on all four sides.

Electron retains `trafficLightPosition: { x: 16, y: 16 }`, so the native button centre remains y=23. A 44px unbordered row inside the 4px frame uses 6px bottom padding: `4 + (44 - 6) / 2 = 23`. A row with a 1px bottom border uses 5px: `4 + (43 - 5) / 2 = 23`. Sidebar rows begin at the window origin and keep their existing top padding. The landing expand button uses a 5px local top offset, giving the same `4 + 5 + 14 = 23` centre for its 28px control. These adjustments leave 5px between a 28px control and the visible canvas edge; text has more clearance.

Moving the native buttons only while the sidebar was collapsed was rejected because window controls would jump during a layout action and renderer state would have to cross into Electron main. Keeping the 8px gutter while lifting page controls to y=23 left only 1px between a 28px button and the canvas edge. Extracting every page header into a new window-level slot could also align the coordinates, but it would broaden a visual correction into a cross-page ownership migration without improving the approved thin-rim composition.

## Verification

The boot-shell browser coverage asserts the 4px origin and 14px radius, and still compares the static first-paint frame with the real `WorkspaceCard`. Focused component coverage also locks the frame-aware macOS padding and landing-control offset; a packaged native macOS screenshot remains the final optical check for fractional display scales.

This correction partially replaces only the geometry recorded by the earlier [boot-shell handoff decision](../feature/2026-10-19-boot-shell-layout-handoff.md). Its startup ownership and readiness guarantees remain current.
