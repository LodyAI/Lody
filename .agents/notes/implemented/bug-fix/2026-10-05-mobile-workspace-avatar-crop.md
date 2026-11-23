# Mobile home workspace avatar crop

Status: implemented
Translation: current

[中文](2026-10-05-mobile-workspace-avatar-crop.zh.md)

## Abstract

The mobile home header placed a 32px workspace tile inside a 36px circular
control, exposing the tile's corners and an unwanted gap. The header now enlarges
the shared tile to fill the control and clips it through a circular mask. Both
the switcher trigger and static identity use this presentation; other workspace
avatars retain their shared tile geometry.

## Decision and evidence

The [avatar migration](../feature/2026-09-13-ui-avatar-kbd.md) standardized
workspace tiles but did not render the mobile home header during verification.
`HomeWorkspaceAvatar` still selected the 32px `large` rung while its host used
36px. A header-owned StyleX wrapper scales the tile by 36/32 and clips at the
control size, preserving the shared image cache, cover fit and fallback.
This avoids overriding primitive classes or changing the avatar ladder globally.

The existing `MobileHomeScreen` Storybook suite now includes a synthetic
non-square logo with and without the workspace-menu callback. Its existing
initial-letter scene covers the no-image presentation. Native-device rendering
remains a separate verification limit.

## Verification

Chrome at a 393×852 viewport rendered both logo stories and the initial-letter
story in light and dark themes. Browser geometry confirmed the avatar, mask and
host all occupy the same 36×36 rectangle; the mask clips overflow and the image
retains `object-fit: cover`. Screenshots were visually inspected.
