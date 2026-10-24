# Preserve settings navigation width on Windows

Status: implemented
Translation: current

PR: [#1499](https://github.com/LodyAI/Lody/pull/1499)

[中文](2026-10-12-settings-navigation-scrollbar.zh.md)

## Abstract

Desktop Settings used a native scrollbar for its navigation and an overlay scrollbar for its content. On Windows, the native scrollbar consumed part of the 48px icon rail, narrowing the buttons and displacing their icons when categories overflowed. Navigation now uses the existing ScrollArea with a visible thumb whenever it overflows. It retains the same category tree and keyboard navigation; packaged Electron and physical display scaling require separate verification.

## Decision

The [narrow-panel change](2026-10-01-narrow-settings-panel.md) keeps navigation mounted when the panel becomes an icon rail. Its native scroll container still reserved platform-dependent scrollbar width. Merely making that scrollbar thin would retain this layout dependency.

[`desktop-settings-modal.tsx`](../../../../packages/components/src/components/settings/desktop-settings-modal.tsx) now reuses the content pane's ScrollArea primitive. The navigation viewport ref owns selected-row scrolling and resize observation; its parent is the scroll-area root, which retains the navigation width. Padding and category spacing belong to the inner content. The feedback footer remains outside the scrolling region. The scrollbar overlays the edge and appears only when needed.

In forced-colors mode, an inset 1px CanvasText outline makes the thumb visible on light and dark system backgrounds, including hover and drag states. This retains automatic system-color adjustment. An initial StyleX background override was ineffective because the primitive's Tailwind background utilities occupy a later cascade layer; the outline avoids that conflict without changing global styles.

No global scrollbar rules, platform detection, font-size preferences, category ordering, or window chrome change. Windows caption transparency already landed in [PR #1437](https://github.com/LodyAI/Lody/pull/1437).

## Verification

At a 500 × 360 viewport in Windows Chromium 145, the original 48px rail had 33px of usable width and 21px buttons, with icons displaced 7.5px left. The replacement retains all 48px, restores 36px buttons, and centers the icons. Headless verification must remove Playwright's default `--hide-scrollbars` flag to expose the original gutter.

The owning [browser suite](../../../../packages/components/tests/e2e/desktop-settings-layout.spec.ts) exercises navigation geometry, scrolling, selection, resize persistence, and nested editors using synthetic Storybook data. Additional regression coverage checks overflow without a width-consuming gutter, actual wheel/thumb interaction, and thumb contrast on light and dark forced-color backgrounds. Existing keyboard expectations follow the Memory category now between Roles and MCP; editor coverage follows the sharing switch to its Team tab. Check results and remaining environment limits are recorded in the PR. Tracking issue: [#1498](https://github.com/LodyAI/Lody/issues/1498).
