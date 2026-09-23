# Align window-top rows with the Windows caption centerline

Status: implemented
Translation: current

[中文](2026-09-23-windows-caption-centerline.zh.md)

## Abstract

On Windows, every h-11 window-top row centered its controls at y=22 while the
OS-drawn caption buttons occupy a 36px `titleBarOverlay` strip centered at
y=18, leaving header icons visibly 4px below the — ▢ ✕ cluster. macOS already
had `useMacTrafficLightRowPadClass` lifting rows onto the traffic-light
centerline; Windows had only the horizontal `pr-[144px]` clearance. The new
`useWindowsCaptionRowPadClass` (`pb-2`, or `pb-[7px]` on bordered rows) shrinks
each row's content box to 36px so controls center on y=18, applied wherever the
macOS pad already runs. Playwright-measured geometry confirms the buttons'
center moved from 4px below to exactly on the caption centerline. Verification
simulated the overlay on macOS — the real buttons were not rendered — but their
36px height is set by our own main-process constant, not guessed.

## Cause and ownership

The Windows caption buttons are not web content: `window.ts` sets
`titleBarStyle: 'hidden'` plus a theme-tinted `titleBarOverlay`, and
`window-theme.ts` pins `MAIN_WINDOW_TITLE_BAR_OVERLAY_HEIGHT = 36`. Electron
fills that strip with three ~46px buttons (hence `pr-[144px]`), glyph
centerline at y=18. The drag-inset model treated Windows as "reserve
horizontal space only": `useWindowsCaptionPadClass` kept controls clear of the
buttons but nothing matched their vertical centerline, unlike macOS where
`useMacTrafficLightRowPadClass` (`pt-[2px]`/`pt-[3px]`) centers every h-11 row
on the lights at y=23.

`ui/window-drag-region.tsx` now exports the Windows analog:
`useWindowsCaptionRowPadClass({ bottomBorder })` returns `pb-2`
(`pb-[7px]` when a 1px bottom border is in the border-box), gated on
`isWindowsElectronRenderer() && !useElectronFullscreen()` like the other
insets. It is applied at every existing traffic-light row-pad call site:
session tab bar and side-panel tab bar (`session-detail.tsx`), the sidebar
header (`loro-sidebar.tsx`), and the archive header (`web-archive-screen.tsx`).
One centerline now rules the whole top strip on Windows, same as on macOS.

## Evidence and limits

- Playwright (faked `__LODY_PLATFORM__.os = 'win32'`) rendered the production
  `SessionTabBar` composition under a simulated 36px WCO strip: toolbar button
  centers measured 4px below the caption centerline before, exactly on it
  after (`test-results/windows-caption-before-after.png` during review).
- `tsgo --noEmit` on `@lody/components`, the `window-drag-region` vitest suite,
  oxfmt and oxlint all pass.
- The strip simulation is faithful because its height is our own constant; the
  real OS buttons were not rendered on macOS. At fractional display scaling the
  DIP relationship is unchanged. `ZoomableImageViewer`'s 56px lightbox banner
  still centers its icons at y=28 — it was intentionally left out of scope.
