# Convert oversized composer pastes into text attachments

Status: implemented
Translation: current

[中文](2026-09-28-oversized-paste-text-file.zh.md)

## Abstract

Pastes above the composer’s existing 500 KiB UTF-8 ceiling used to be rejected,
even though the product already had a complete file-attachment path. The two
composer entry points now preserve that clipboard text in a non-editable
`text/plain` file named `pasted-text.txt` and add it through the ordinary
attachment draft flow. Smaller pastes keep their existing inline or folded
behavior, while clipboard file filtering, file-count limits, size validation,
upload, retry, and persistence remain shared with manually attached files.

## Decision and evidence

- `createPastedTextFile` keeps the raw clipboard string, including its original
  line endings and surrounding whitespace. The 500 KiB decision still uses the
  existing normalized-and-trimmed UTF-8 measurement, so only text that would
  previously have been rejected takes this path.
- The landing and existing-session paste handlers create the generated file and
  merge it with the files selected by `selectPastedClipboardFiles` before one
  attachment call. This preserves the rule that rendered Word/PowerPoint
  screenshots lose to text while real clipboard files remain attachments.
- The generated file uses the existing ordinary file draft and send pipeline.
  It therefore inherits the current 100 MiB per-file limit and eight-file
  message limit, with no new upload state, protocol field, or text editor.
- This decision supersedes the exclusion recorded in
  [the 2026-09-14 size-ceiling note](2026-09-14-composer-paste-size-ceiling.md)
  without rewriting that historical record. The earlier editable-file
  experiment remains withdrawn for the regression reasons documented in
  [the context-fallback note](2026-09-09-conversation-context-fallback.md).

## Verification and limits

- The rendered session-composer suite verifies that an over-limit paste creates
  a `pasted-text.txt` card, preserves the exact bytes and MIME type, emits no
  oversize error toast, and merges a real clipboard file in the same paste.
- The same suite keeps coverage for the inclusive boundary: exactly 500 KiB
  remains a folded pasted-text chip. A pure helper test checks filename, MIME,
  byte length, and raw text preservation.
- The landing handler uses the same helper and attachment selection logic but
  is not exercised through a full rendered landing page in this change. A
  packaged desktop clipboard round trip remains unverified.

PR: [#1078](https://github.com/LodyAI/Lody/pull/1078)
