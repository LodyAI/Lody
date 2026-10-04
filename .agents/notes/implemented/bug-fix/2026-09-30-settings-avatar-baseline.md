# Settings account avatar baseline

Status: implemented
Translation: current

[中文](2026-09-30-settings-avatar-baseline.zh.md)

## Abstract

The desktop settings account avatar appeared raised relative to its username.
The avatar and image were both 24×24px, but their wrapper formed an inline line
box with extra descent space. Making the wrapper a flex container removes that
space and centres the avatar in the row. The existing horizontal alignment and
cover crop remain intact; Playwright verifies the actual rendered geometry.

## Evidence and decision

The [leading-column decision](2026-09-27-leading-icon-column.md#settings-account-avatar)
introduced a wrapper with negative inline margins around the avatar. At the
14px interface tier, Chromium measured that wrapper at 24×29.296875px and the
avatar at 24×24px. The wrapper was centred, leaving the avatar 2.6484375px above
the username and button centre.

`settingsSurface.listRowAvatar` now uses `display: flex` and `alignItems: center`.
This removes the inline baseline contribution at its owner. Changing image
dimensions or crop rules would not address the measured wrapper defect.

## Verification

- The settings case in
  [sidebar-nav-leading-column.spec.ts](../../../../packages/components/tests/e2e/sidebar-nav-leading-column.spec.ts)
  fails before the fix and passes afterward. It measures square dimensions,
  vertical centring and the shared icon centreline for image and initials
  avatars, light/dark palettes and 12/14/18px interface tiers.
- [SettingsAccountEntry stories](../../../../packages/components/src/stories/SettingsAccountEntry.stories.tsx)
  use a synthetic non-square source. The image fills the 24px box with `cover`.
- `@lody/components` typecheck passes. Before/after screenshots use the same
  component, synthetic source and viewport; they are local acceptance artifacts,
  not captured account data or an authenticated desktop integration test.
