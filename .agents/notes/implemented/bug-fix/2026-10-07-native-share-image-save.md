# Native share-image export

Status: implemented
Translation: current

[中文](2026-10-07-native-share-image-save.zh.md)

## Abstract

Share-card exports fell through to a browser blob download inside the native mobile
shell, then reported success even though WKWebView could not save that download.
PNG export now reuses the local cache-file and system share-sheet path already used
by file previews. Dismissal preserves the preview and selected messages; failures
remain retryable and temporary files are cleaned up. This fixes the shared export
routing; real-device photo-library permissions and destination behavior still need
native acceptance testing.

## Decision and evidence

The [earlier mobile fix](2026-09-18-mobile-share-as-image.md) made selection and the
preview reachable, but `exportShareImage` still had only Electron and browser
branches. The existing `session-file-download.ts` already documents why native
WKWebView needs a real local file instead of an anchor with a blob URL.

Reuse `shareFileBytesNatively` for the captured PNG, preserving its `.png` suffix
and sanitized display name. The helper returns `{ shared }` so a cancelled sheet
is distinguishable from completed handoff. Existing file-preview callers can
continue ignoring the result. PNG dialogs already use `{ saved }` to decide
whether to complete selection, so they need no separate UI state machine.

```text
capture PNG
  Electron -> native save dialog
  native mobile -> isolated cache PNG -> system share sheet -> cleanup
  browser -> blob download
cancel -> keep preview and selection
failure -> keep preview and offer retry
```

Do not add a new photo-library plugin or silently fall back to a browser download.
The system sheet owns destination choice: iOS can offer Save Image, but completion
also includes other share targets and does not prove an album write. Both chat and
usage cards use the same export helper. No private mobile source or cloud request
is introduced.

## Verification

The export suite exercises the real native helper with an in-memory filesystem and
share-sheet boundary, checking exact PNG bytes, filename, completion, cancellation,
failure, cleanup, and absence of browser downloads. The native-file suite checks
chunked bytes, concurrent isolation, cancellation variants, and cleanup on failure.
Electron save and browser download/clipboard regressions remain covered. These
checks do not replace a native device test of the system sheet and photo permissions.
