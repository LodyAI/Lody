# Persistent macOS app icon selection

Status: implemented
Translation: current

[中文](2026-09-23-macos-app-icons.zh.md)

## Abstract

The desktop now offers Default and Aqua previews below Terminal in Appearance
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
Alternate ASAR artwork is copied to a temporary real file and removed after AppKit consumes
it. The Aqua source (`build/icon-aqua.png`) preserves the iOS artwork. The macOS
runtime asset adds 10% transparent padding per side and uses the default padded
icon's alpha silhouette for matching rounded corners. Settings, Finder and Dock
all use this derived PNG; a raw iOS square appears oversized in the Dock.
Regenerate from `apps/electron` (requires Pillow and macOS iconutil):

```sh
python3 scripts/pad-mac-icon.py --input-png build/icon-aqua.png \
  --output-png resources/app-icons/aqua.png --output-icns /tmp/lody-aqua.icns \
  --pad 0.10 --mask-png build/icon-mac.padded.png
```

After changing or clearing the Finder icon, the native helper forces
`LSRegisterURL(..., true)` and notifies `NSWorkspace` of the bundle change before
updating the running Dock tile. This requests an immediate refresh of registered
application information rather than waiting for the next launch. A failure after
partial native application attempts to restore the previous choice without
persisting the failed selection. Neither global cache deletion nor a Dock restart
is used.

## Evidence and limits

The feature-specific native/controller tests and the added desktop UI test
parameterization were removed at the maintainer’s request. Test and ablation
results below record development-time experiments, not retained regression coverage.

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

The first quit after a selection was reported to briefly restore the old Dock
icon, with later launches/quits correct. The registration refresh is a mitigation:
Apple documents refreshing Launch Services information, not a guarantee that Dock
invalidates its launch-time icon cache. The native probe passes with the refresh,
and a deterministic controller test covers failure after the icon was written.
A pinned Dock item across first quit has **not** been visually verified; the
reporting Mac is unavailable remotely. Verify Default → Aqua → quit and
Aqua → Default → quit on that machine before treating the cache bug as resolved.

## Ablation evidence

Single-variable experiments against `0acb7427` distinguish redundancy from guards:

| Removed | Observed result | Decision |
| --- | --- | --- |
| Default-icon temporary PNG copy | Same native reset and strict signature result; temporary mkdir/read/write/remove each drop from 1 to 0; reset also succeeds when temporary storage is unavailable | Remove |
| Serialized queue | Competing-window ordering test fails | Keep |
| Rollback | Preference-write and partial-native-failure tests fail | Keep |
| Startup reapplication | Restart/update restoration test fails | Keep |
| Conf constructor normalization | Packaged CommonJS import is an object; direct construction throws `Conf is not a constructor` | Keep |

The service experiment transpiled the real service with an injected Electron app
and instrumented filesystem, using real preferences and native helpers on a signed
temporary bundle. Aqua still writes the custom icon and cleans its temporary PNG.
Dock drawing was injected, so this does not close the first-quit visual gap above.
Refresh calls were not classified as redundant: the available tests cannot observe
the reported Dock cache issue, so passing without them would not prove equivalence.
