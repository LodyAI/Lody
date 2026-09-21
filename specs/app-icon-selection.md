# App icon selection

Status: draft
Translation: current

[中文](app-icon-selection.zh.md)

In a native host that supports alternate app icons, a person can open Appearance
settings and select a bundled icon by its preview immediately below Font size,
then later restore the default. Hosts without this capability show no icon picker.

The host provides the icon catalog and reads and changes the installed icon.
The shared UI waits for native confirmation before moving the checkmark, disables
choices while a change is pending, and retains the previous selection on failure
with a visible retryable error. Opening the settings reads the native state again.
Selection belongs to the device; it is not a workspace or account preference.

## Evidence

- `packages/components/src/components/mobile/mobile-app-icon-settings.tsx`
- `packages/components/tests/mobile-app-icon-settings.test.tsx`
- `packages/components/src/stories/MobileAppIconSettings.stories.tsx`

This repository does not own native packaging or establish physical-device behavior.
