# Align macOS traffic lights and sidebar row columns

Status: implemented
Translation: current

[中文](2026-09-29-macos-sidebar-traffic-light-column.zh.md)

## Abstract

In a macOS desktop screenshot, the first traffic light sat about 6px to the right of the navigation icon, while navigation, project, repository and session labels started at four slightly different positions. Moving only the native lights would leave the sidebar visibly uneven. The main window now places the lights 6px farther left and the desktop row layouts share a 15px icon/group column and a 37px ordinary-label column. Native macOS verification remains necessary because Linux cannot draw Electron's traffic lights.

## Evidence and ownership

The supplied screenshot shows the first light's centre near x=30 relative to the window and the navigation icon's centre near x=24. The window configured `trafficLightPosition.x = 20`, which Electron uses for the native button group. The screenshot's apparent 6px difference is consistent with that group being offset from the sidebar icon column. The window now uses `x = 14` and retains `y = 16` and the existing fullscreen gate.

The first pass incorrectly treated the rows below navigation as aligned. Source box geometry, relative to the sidebar's left edge, showed four label starts: navigation 38px, local project 37px, repository 39px and flat session 35px. The common group label starts at 15px. Desktop navigation now starts its icon at 15px and its label at 37px; the other row types retain their 15px leading slot and move their ordinary label to 37px. Mobile navigation keeps its former spacing. A nested Session intentionally adds a 12px tree indent, while an owner avatar or pinned mark also shifts its title as content rather than as a baseline error.

## Verification and limit

The source and screenshot geometry were reviewed. This checkout has no installed frontend dependencies and runs on Linux, so no native macOS after screenshot or Electron smoke test was produced here. The corrected comparison artifact in the Lody conversation is a geometry illustration, not a native product capture. A macOS build should confirm the first light's optical centre, the sidebar columns and the collapse/back controls at ordinary and fractional display scales.
