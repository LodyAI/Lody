# Preserve file preview errors and explicit recovery

Status: implemented
Translation: current

[中文](./2026-10-16-file-preview-failure-recovery.zh.md)

## Abstract

File preview converted all realpath failures into file-not-found, so an existing
file could be described as deleted after an access or I/O failure. Reopening its
already-active error tab only changed focus and did not read again. Preserve the
filesystem failure category, provide explicit Retry, and reread failed previews
on a new open request while retaining successful snapshots and drafts. Local
structured logs now identify the resolution and read stages without file contents;
these fixes do not establish the cause of any particular device report.

## Decision and ownership

- Path policy preserves non-missing errors from the native/fallback realpath pair
  and tolerant directory listing; EACCES/EPERM map to permission denied and other
  non-missing failures to transient I/O. Only ENOENT/ENOTDIR imply absence.
- Remote classification still checks every candidate against allowed roots before
  exposing failure categories. Successful resolution still authorizes the real path.
- A failed viewer owns explicit retry. A changed open/focus request retries only
  error/missing state; successful previews keep their snapshot and unsaved edits.
  Existing load cleanup ignores late results on dependency change/unmount; this
  does not claim cancellation of the underlying filesystem read.
- CLI logs workspace/owner rejection and path resolution with requested path,
  workspace root, owner, canonical result and bounded probe errors. Electron logs
  the actual read outcome/duration. JSON escapes path control characters; logs
  contain neither file contents nor resource capability URLs.
- Keep the existing Promise service and synchronous resolver for this fix. A native
  Effect conversion would include the unfinished MessageHandler workspace resolver
  and Electron resource ownership; no migration unit or ledger completion is claimed.

## Verification and limits

The existing path-policy and service suites exercise real temporary files plus
injected OS errors, remote boundary masking, and content-free diagnostic payloads.
The existing React viewer suite verifies error-to-content recovery through both
reopen and Retry, and retention of successful content on a later focus request.
Fixtures are synthetic; no device logs or user paths are committed. Packaged-device
reproduction and identification of the original device failure remain unverified.
Related ownership: [file preview README](../../../../apps/cli/src/lib/file-preview/README.md),
[file surfaces](../../../docs/sessions-file-surfaces.md).
