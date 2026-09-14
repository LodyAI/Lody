# Native sharing from file previews

Status: implemented
Translation: current

[中文](2026-09-14-native-file-sharing.zh.md)

PR: https://github.com/LodyAI/Lody/pull/685

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

CI run 34802071337 subsequently exposed a test assertion cost: generic deep equality
over the 3 MiB Buffer exceeded the 5-second timeout (the only failure among 3,624
component tests). Use Buffer.equals for exact length-and-byte comparison instead;
the fixture, chunk boundary, and timeout stay unchanged. Locally the native suite
dropped from 4,482 ms to 163 ms; all 36 related tests passed with two workers, as did
targeted formatting and lint. These timings are observations, not test assertions.

Review follow-up: the notice action builder now requires a binary snapshot with
bytes before exposing native sharing. Error cards call it without a snapshot and
retain copy/local-host actions; empty binary snapshots remain shareable. The
export guard and pending state now apply only to native shells so overlapping
browser downloads are independent. All 32 related tests passed, including explicit
deferred-read coverage for concurrent browser downloads and native lock release,
plus notice availability for missing and empty bytes. Targeted lint passed; the
existing local dependency/submodule limitations still apply to full checks.
