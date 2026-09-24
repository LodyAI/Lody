# App icon selection

Status: draft
Translation: current

[中文](app-icon-selection.zh.md)

In a native host that supports alternate app icons, a person can open Appearance
settings and select a bundled icon by its preview, then later restore the default.
The picker appears below Terminal on desktop and below Font size on iOS. Hosts without this capability show no icon picker.

The host provides the icon catalog and reads and changes the installed icon.
The shared UI waits for native confirmation before moving the checkmark, disables
choices while a change is pending, and retains the previous selection on failure
with a visible retryable error. Opening the settings reads the native state again.
Selection belongs to the device; it is not a workspace or account preference.

On packaged macOS desktops, the choices are Default and Aqua. The main process
serializes changes across windows, stores the confirmed choice locally, and
reapplies it on launch so replacement during an update does not lose the preference.
Default removes the Finder custom icon; the running Dock follows the selection.
Windows, Linux, browser hosts, and unpackaged Electron do not expose this capability.
Only bundled icon identifiers are accepted, never renderer-provided file paths.

macOS custom icons use Finder metadata. Signed resources remain unchanged and
ordinary signature verification passes, but strict verification rejects that
metadata until Default is restored. Release artifacts must still ship without
custom metadata and pass strict signing/notarization checks.

## Evidence

- `packages/components/src/components/mobile/mobile-app-icon-settings.tsx`
- `packages/components/tests/mobile-app-icon-settings.test.tsx`
- `packages/components/src/stories/MobileAppIconSettings.stories.tsx`
- `apps/electron/src/main/services/app-icon-service.ts`

Development-time native probes checked on-disk customization and signature
preservation on a temporary signed macOS bundle. The feature-specific native and
controller test files were subsequently removed; those results are historical evidence. A full notarized-app update cycle remains a
release verification requirement. iOS packaging belongs to its external host.
