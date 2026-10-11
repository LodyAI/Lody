# Touch actions in the shared image viewer

Status: proposed
Translation: current

[中文](2026-10-08-image-preview-touch-actions.zh.md)

## Abstract

The shared full-screen viewer has desktop copy/save but no touch export entry.
A stationary touch hold now opens the existing UI menu inside the viewer's modal
boundary, while PhotoSlider retains its gesture engine. Export reuses Electron's
bridge, browser bitmap/file APIs and the existing native file-sharing helper.
Native copy depends on available browser bitmap clipboard support, and native
Save means choosing a destination in the share sheet, not a verified album write.

## Decision

The implementation follows [issue #1284](https://github.com/LodyAI/Lody/issues/1284)
and the [draft intent](../../../../specs/image-preview-actions.md). It extends the
[existing modal](../../implemented/bug-fix/2026-09-30-image-viewer-modal-focus.md)
without replacing the photo engine. A 500 ms hold is cancelled after 10 px of
travel, another finger, release, pointer cancellation, blur, or image replacement.
The menu stays inside the modal and above the photo; dismissal retains the image.

Prepare the selected original file before enabling menu actions: Web Share needs
an explicit click with live user activation. PNG clipboard encoding remains a
promise passed synchronously to ClipboardItem, matching the share-card exporter.
Native file export uses isolated temporary files and cancellation/cleanup already
owned by `session-file-native-save.ts`. Do not invent a private native clipboard
bridge or report URL copying as bitmap copying. Unavailable actions are labelled.

## Verification limits

The three focused suites pass 48 tests with one worker: deterministic hold/menu
cancellation and image identity, browser export outcomes, original native bytes,
and native cancellation/cleanup. Components and repository-wide typechecks pass,
as do changed-file formatting/type-aware lint (zero errors, ten warnings), i18n
and boundary guards. One parallel run
hit a share-card native-mock timeout; the isolated and single-worker runs pass.
The aggregate check stopped when its type-aware lint helper was killed; it did
not reach the full repository test stage. Docs retain six pre-existing links
into uninitialized Kimi/Pi submodules.
Desktop/native browser gestures and the actual iOS/Android share sheet require
real-device acceptance; jsdom does not establish them. No screenshots or live
product validation are claimed.
