# Refuse a composer paste above a 500 KiB byte ceiling

Status: implemented
Translation: current

[中文](2026-09-14-composer-paste-size-ceiling.zh.md)

## Abstract

Pasting a large log into the composer used to collapse into a `[Pasted N chars]`
chip with no upper bound, so an accidental multi-megabyte dump stayed hidden
behind a short label while riding along in every draft save, every prompt
rewrite, and the turn itself — the user only discovered the mistake after
sending. The composer now measures what the draft would actually store and
refuses any paste whose UTF-8 size exceeds 500 KiB, cancelling the paste and
raising an error toast that names both sizes and points at the file-attachment
path. The ceiling is a client-side composer guard only: it does not bound text
that arrives by typing, by editing an existing pasted-text draft, or by any
non-paste entry point, and it is not a server-side limit.

## Decision and evidence

- The ceiling is measured in UTF-8 bytes, not characters. "500 KB" describes a
  payload, and a character count would let a CJK log through at roughly three
  times the intended size. `getPastedTextByteSize` encodes the
  normalized-and-trimmed string that `insertPastedTextDraft` would store, so the
  number the toast shows is the number the draft would cost rather than the raw
  clipboard payload.
- The guard sits in the two composer paste handlers
  ([session](../../../../packages/components/src/components/sessions/session-chat-input-area.tsx),
  [landing](../../../../packages/components/src/components/chat/chat-landing.tsx))
  ahead of the existing `shouldCapturePastedTextDraft` collapse, and refuses the
  whole paste rather than truncating it: a half-pasted log is worse than none,
  because the user cannot tell where it was cut. Task body and comment
  composers keep their existing paste behavior; they are not agent turns and do
  not carry pasted-text drafts.
- The threshold lives beside the existing collapse threshold in
  [`pasted-text-draft.ts`](../../../../packages/components/src/lib/pasted-text-draft.ts)
  so the two limits stay readable against each other: above 1024 characters a
  paste collapses, above 500 KiB it is refused.
- The toast reuses `formatFileSize` from session file presentation rather than a
  second byte formatter, so a refused paste reads in the same units as an
  oversized attachment.

## Verification and limits

- [`session-chat-input-submission.test.tsx`](../../../../packages/components/tests/session-chat-input-submission.test.tsx)
  dispatches a real paste event at the rendered composer: one byte over the
  ceiling leaves the draft untouched and raises exactly one error toast, while a
  paste exactly at the ceiling still collapses into a chip. Both assert the
  resulting textarea value, so removing the guard fails the first case.
- [`pasted-text-draft.test.ts`](../../../../packages/components/tests/pasted-text-draft.test.ts)
  covers the boundary itself: the ceiling is inclusive, CJK text crosses it at a
  third of the character count, and surrounding whitespace and CRLF are
  normalized away before measuring.
- Only the session composer is exercised through a rendered component; the
  landing composer shares the helper and the same handler shape but is verified
  by reading, not by a test. The refusal was not exercised against a real
  clipboard in a packaged desktop build.
