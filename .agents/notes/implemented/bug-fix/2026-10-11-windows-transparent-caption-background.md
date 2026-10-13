# Transparent Windows caption background

Status: implemented
Translation: current

[中文](2026-10-11-windows-transparent-caption-background.zh.md)

PR: [#1437](https://github.com/LodyAI/Lody/pull/1437)

## Abstract

Windows native caption buttons kept an opaque theme background when a Modal or
Dialog dimmed the renderer, leaving a visible patch in the upper-right corner.
Both themes now use Electron's transparent Window Controls Overlay background,
so the renderer backdrop can show beneath the native controls. The 36px height,
theme-specific glyph colors, and native button behavior remain unchanged. The
configuration and theme transitions pass unit tests; Windows visual verification
remains outstanding.

## Decision and ownership

`window-theme.ts` supplies `color: '#00000000'` for both themes. `window.ts`
uses that helper at creation; `app-ipc.ts` already uses it through
`applyResolvedWindowTheme` for explicit and system theme updates. The window's
own background remains opaque. No Modal state IPC, custom caption buttons, or
native addon is needed.

This changes the caption background described in the earlier
[caption alignment decision](2026-09-23-windows-caption-centerline.md), preserving
its geometry. The current explanation lives in
[session chrome](../../../docs/sessions-tabs-routing.md).

## Evidence and limits

The checkout pins Electron 43.7.6, rather than the reported 44.7.0. Its
[`WinCaptionButtonContainer::UpdateBackground`](https://github.com/electron/electron/blob/v43.7.6/shell/browser/ui/views/win_caption_button_container.cc#L139)
already marks the layer non-opaque when the overlay background has alpha below
255; no dependency upgrade is required. See also Electron
[PR #38693](https://github.com/electron/electron/pull/38693).

The existing `window-theme.test.mjs` suite passes all four tests. Its theme test
now checks resulting window appearance against explicit colors and height,
including light → dark → light and macOS platform gating, rather than comparing
recorded calls with the same helper under test. `pnpm check` stops at missing
`tsgo`/`tsc`; Oxfmt is also unavailable because this checkout has no dependencies.
Native rendering, hover behavior, maximize/restore, and Modal/Dialog appearance
in both themes still need a Windows smoke check.
