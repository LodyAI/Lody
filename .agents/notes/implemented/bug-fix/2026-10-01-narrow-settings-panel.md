# Keep desktop Settings usable in narrow windows

Status: implemented
Translation: current
PR: [#1198](https://github.com/LodyAI/Lody/pull/1198)

[中文](2026-10-01-narrow-settings-panel.zh.md)

## Abstract

Desktop Settings kept a fixed 240px navigation column even when its panel was
only 420px wide, squeezing Role names and clipping the Add role button. The panel
now uses a single horizontally scrolling row of category items above the page
when it is at most 720px wide — an edge-to-edge band that is the tab strip's
tray, scroll arrows at its ends — and its header actions wrap. Both navigation
presentations use the same filtered items and selection handler; resizing
preserves the page and open editor draft. Browser regression coverage exercises
geometry and nested-editor interaction with synthetic catalog data; packaged
Electron and live cloud workspaces remain outside this check.

## Cause and decision

At a 500px desktop viewport, `84vw` yields a 420px panel. The non-shrinking 240px
sidebar leaves 180px for the page, before its insets. The non-wrapping title/actions
row can overflow that space while the panel clips it. Desktop devices deliberately
keep the desktop renderer at narrow widths, per the
[compact-desktop decision](../feature/2026-09-25-compact-desktop-layout.md).

[`desktop-settings-modal.tsx`](../../../../packages/components/src/components/settings/desktop-settings-modal.tsx)
owns the named inline-size container and both navigation presentations. A container
query selects the layout without remounting the page. The compact presentation is
the `Tabs` strip flush against the panel: its band is the tray itself, without
inset, holding Account and each available category — retaining
capability/member/native-shell filtering. End arrows page the overflow and a
fading edge mask marks it; selection and rail resizing reveal the active item.
Only the rail scrolls, never the page. A Base UI dialog popup stops composite
keys (arrows, Home/End) at the portal edge, so window-level scope navigation had
never seen them — the sidebar's arrow keys were inert inside the overlay.
`FocusScope` now runs a scope's navigation and the Left/Right scope switch on the
scope element's own keydown, after controls inside it and before the popup's
stop; the tab strip's composite handles its own Left/Right before either. Bug
report remains an accessible button when available. Header titles and action
clusters wrap; narrow headers remove the redundant inner column padding.

Shrinking the sidebar alone leaves too little reading width. A full multi-row
navigation above the page would consume the short window's scrolling area. A
dropdown was considered but hides adjacent categories behind another click; a
strip floating in a padded bar and a grouped underline row were both tried and
rejected for their chrome; the tray as the band itself keeps the control's
affordance without any inset. Its trade-off is that distant categories require
horizontal scrolling, marked by arrows and the fading edge. Nested editor sizing,
focus management and scrolling remain with the existing dialog and form,
including
[pane-centred placement](2026-09-26-settings-editor-dialog-placement.md).

## Verification

[`DesktopSettingsModal` stories](../../../../packages/components/src/stories/DesktopSettingsModal.stories.tsx)
add a read-only synthetic Role catalog without transport or real account writes.
[`desktop-settings-layout.spec.ts`](../../../../packages/components/tests/e2e/desktop-settings-layout.spec.ts)
checks the actual rendered panel at 400, 500, 707, 900 and 1180px, category parity,
the overflow fade, keyboard selection, selected-item visibility and one-row
navigation, draft retention through resize, Chinese/dark actions, focus wrapping,
Escape return, and scrollable editor content above visible Cancel/Save at 707×394.

All ten browser tests pass. Restoring the pre-fix modal makes the 500px geometry
test fail: Add role ends at 508.125px while the panel ends at 460px. Short-height
tab navigation also keeps its last category inside the panel. Component
typechecking and root formatting pass; repository-wide verification is reported
in the PR separately from these behavioral checks.

The [desktop-window Spec](../../../../specs/desktop-windows.md) remains draft.
This change does not establish live save/dispatch behavior or packaged Electron
rendering, and does not change Role catalog or authorization contracts.
