# Schedules page chrome when the navigation sidebar is hidden

Status: implemented
Translation: current

[中文](2026-10-09-schedules-sidebar-toggle-traffic-lights.zh.md)

## Abstract

With the left navigation sidebar collapsed, the desktop Schedules page had no
expand control and its title sat under the macOS traffic lights. The list header
now shows the same PanelLeft expand control as Chat Landing and Archive, and on
macOS Electron it insets to 96px so the title clears the light cluster. Mobile
keeps its own home chrome and does not gain this desktop control.

## Decision

Reuse Archive's in-header placement rather than Chat Landing's absolute overlay:
Schedules already has a 44px title row, so the expand button belongs in that
row. Horizontal inset matches Chat Landing (`paddingLeft` 100px and −4px on the
button → 96px, 24px past the lights that end at x=76). Vertical alignment uses
the shared macOS traffic-light and Windows caption row pads. The list reads
`navigationSidebarVisibleAtom` itself because the inset and the button are one
header layout.

Rejected: overlaying Chat Landing's floating slot on top of the title row, which
would stack two left-edge controls; and leaving the title at 16px padding when
the sidebar is hidden.

## Verification

`schedule-list` tests cover hidden vs visible sidebar, mobile omission, click-to-
reveal, and the macOS inset marker: 10 tests passed in this worktree. Storybook
adds `SidebarHidden` and `SidebarHiddenBesideTrafficLights`. Packaged Electron
with live traffic lights is not claimed from Storybook overlays. A nested
worktree Storybook using a sibling `node_modules` link did not finish rendering
stories (`@lody/ui` export scan), so visual iframe screenshots are not evidence.
