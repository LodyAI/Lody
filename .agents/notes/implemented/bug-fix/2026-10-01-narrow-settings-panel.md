# Keep desktop Settings usable in narrow windows

Status: implemented
Translation: current
PR: [#1198](https://github.com/LodyAI/Lody/pull/1198)

[中文](2026-10-01-narrow-settings-panel.zh.md)

## Abstract

Desktop Settings kept a fixed 240px navigation column even when its panel was
only 420px wide, squeezing Role names and clipping the Add role button. The panel
now uses a single horizontally scrolling row of category items above the page
when it is at most 720px wide — the same column collapsed to its icon rail,
labels and group headings folded away, each row named for assistive technology
and on hover — and its header actions wrap. Both widths share one navigation
tree, so selection and keyboard scope survive resizing, as does the open editor
draft. Browser regression coverage exercises geometry and nested-editor
interaction with synthetic catalog data; packaged Electron and live cloud
workspaces remain outside this check.

## Cause and decision

At a 500px desktop viewport, `84vw` yields a 420px panel. The non-shrinking 240px
sidebar leaves 180px for the page, before its insets. The non-wrapping title/actions
row can overflow that space while the panel clips it. Desktop devices deliberately
keep the desktop renderer at narrow widths, per the
[compact-desktop decision](../feature/2026-09-25-compact-desktop-layout.md).

[`desktop-settings-modal.tsx`](../../../../packages/components/src/components/settings/desktop-settings-modal.tsx)
owns the named inline-size container; one navigation tree serves both widths and
a container query collapses it in place — no second presentation to keep in
step, and focus scope survives the resize. Below the breakpoint the column is
52→48px of icon rows: the sidebar's own glyphs, grouped as it groups them, the
current row keeping its wash. Rows carry their name for assistive technology
and, while the rail is showing, as a tooltip. A short window scrolls the column
itself; selection and rail resizing reveal the active row — only the column
scrolls, never the page. A Base UI dialog popup stops composite keys (arrows,
Home/End) at the portal edge, so window-level scope navigation had never seen
them — the sidebar's arrow keys were inert inside the overlay. `FocusScope` now
runs a scope's navigation and the Left/Right scope switch on the scope element's
own keydown, after controls inside it and before the popup's stop. Bug report
remains an accessible button when available, icon-only on the rail. Header
titles and action clusters wrap; narrow headers remove the redundant inner
column padding.

Shrinking the sidebar alone leaves too little reading width. A navigation band
above the page was tried three ways — a segmented strip floating in a padded
bar, a grouped underline row, and the strip flush edge to edge — and each read
as foreign chrome: the panel's own sidebar collapses instead, the way app
sidebars collapse to their icon column. The rail's trade-off is that categories
are glyphs until hovered or read by assistive technology; the labels return at
full width. Nested editor sizing, focus management and scrolling remain with
the existing dialog and form, including
[pane-centred placement](2026-09-26-settings-editor-dialog-placement.md).

## Verification

[`DesktopSettingsModal` stories](../../../../packages/components/src/stories/DesktopSettingsModal.stories.tsx)
add a read-only synthetic Role catalog without transport or real account writes.
[`desktop-settings-layout.spec.ts`](../../../../packages/components/tests/e2e/desktop-settings-layout.spec.ts)
checks the actual rendered panel at 400, 500, 707, 900 and 1180px, category parity,
rail scrolling, keyboard selection, selected-item visibility and one-column
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
