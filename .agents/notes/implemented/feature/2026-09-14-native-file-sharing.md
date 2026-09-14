# Native sharing from file previews

Status: implemented
Translation: current

[中文](2026-09-14-native-file-sharing.zh.md)

## Abstract

Binary previews on mobile offered only a host path even though the client could
read the file. Native file actions now export complete preview bytes through the
system share sheet, preserving Copy file path. The existing remote preview size
limits remain; large-file transfer is a separate protocol change. Native device
handoff still needs manual verification.

## Decision and evidence

The shared file-actions hook owns platform selection for both the notice and menu.
It uses the existing authorized file provider, never passes a remote path to the
device, and suppresses overlapping exports. The native save helper reuses chunked
cache writing with a random directory per export, safe filenames, cancellation
handling, and best-effort cleanup even after a failed write.

This extends [local file actions](../bug-fix/2026-09-09-local-file-link-actions.md).
The existing attachment downloader stays intact; raising preview limits or adding
a second transfer endpoint would expand scope. Intent is recorded in the
[draft Spec](../../../../specs/local-file-link-actions.md).

## Verification

29 targeted tests passed using dependencies borrowed from an existing checkout:
native byte integrity across a chunk boundary, empty files, concurrent filename
isolation, cancellation/failure cleanup, file-action routing, and error presentation.
Stories cover native ready and pending states. Complete checks could not pass:
the worktree lacks installed dependencies/submodules, and the borrowed installation
has incompatible workspace types. Document checks report existing missing submodule
links. iOS/Android share-sheet appearance and receiving-app handoff remain untested.
