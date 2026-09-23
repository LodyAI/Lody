# Persistent macOS app icon selection

Status: implemented
Translation: current

[中文](2026-09-23-macos-app-icons.zh.md)

## Abstract

The desktop now offers Default and Aqua previews below Font size in Appearance
on packaged macOS. It reuses the native-host picker and stores successful choices
locally, restoring them after restart or bundle replacement. AppKit changes
Finder custom metadata while Electron updates the running Dock. Ordinary code
signature validation passes, but strict validation rejects custom icon metadata;
restoring Default removes it. A notarized end-to-end update has not been verified.

## Decision

This extends the [host picker decision](2026-09-20-app-icon-selection.md).
The renderer installs the existing optional bridge only on macOS, and main
reports unpackaged runs as unsupported to avoid modifying Electron.app.
The catalog contains bundled artwork; IPC verifies the product-window sender
and rejects arbitrary paths. An async queue orders startup, settings reads,
and changes across windows. Successful native application precedes persistence;
a failed persistence write rolls back the native icon. Preference storage opens
only inside the queued operations: corrupt cosmetic settings recover to Default,
and filesystem failures remain retryable icon errors instead of aborting startup.

```text
Appearance picker → app IPC → serialized icon controller
                               ├─ AppKit custom icon + Electron Dock
                               └─ userData/app-icon.json
Startup/settings read → reapply saved choice to current bundle
```

The system `/usr/bin/osascript` Objective-C bridge calls NSWorkspace without a
downloaded helper or runtime compiler. Paths are argv, not script interpolation.
ASAR artwork is copied to a temporary real file and removed after AppKit consumes
it. The Aqua asset is the same artwork as the iOS alternate icon.

## Evidence and limits

Tests cover restart/update restoration, default reset, native/write failures,
serialization and unsupported/invalid input. The macOS probe checks the Finder
flag, unchanged signed resources, ordinary signature validation, and strict
validation after clearing the icon. A copied installed Lody bundle exhibits the
same results; the original installation was not modified.

Correction to the initial assumption: avoiding signed resources does **not** mean
all signature checks pass. `NSWorkspace.setIcon` adds FinderInfo and a resource
fork; `codesign --verify --deep` passes, while `--strict` rejects this metadata.
See [Apple QA1940](https://developer.apple.com/library/archive/qa/qa1940/_index.html).
Never use this customization on release artifacts before signing/notarizing.
The available installed app was already rejected as Unnotarized Developer ID,
so it could not establish Gatekeeper behavior or a notarized update cycle.
Do not present those unexecuted checks as passed.
