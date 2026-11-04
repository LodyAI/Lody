# Explain sharing failures by operation

Status: implemented
Translation: current

[中文](2026-10-06-sharing-error-feedback.zh.md)

## Abstract

Sharing previously replaced nearly every failure with the same settings hint,
including clipboard rejection. The UI now maps known errors to localized recovery
advice and preserves the operation when the cause is unknown. Publication, reset
and revocation response loss stays explicitly uncertain. Retry identity and
credential handling remain unchanged.

## Decision and evidence

The action runner captures its operation locally, independently of React progress:
publication resets progress in `finally` before the outer error handler runs.
Known structured error codes and exact local errors select safe messages; arbitrary
server payloads are never shown. Image acquisition adds context and preserves aborts.
Quota responses do not identify which quota was hit, so copy names the possible
limits and their numeric ceilings without inventing a specific cause. Content and
selection messages interpolate public `SHARE_LIMITS`, so changing the policy also
changes the displayed ceiling. A generic object-size error lists applicable size
limits because the encoder does not identify the object kind. HTTP errors without structured causes
use operation-specific advice instead of guessed authentication failures.

This extends the [sharing implementation](../feature/2026-09-09-session-sharing.md)
and [sharing intent](../../../../specs/session-sharing.md). It does not change
publication authority, retry state or storage contracts.

## Validation

Hook tests exercise admission, capture, upload, uncertain commit, clipboard and
link-management failures, safe copy and retry recovery. Publisher coverage checks
failed image acquisition and source cleanup. See the task result for executed
checks and environment limitations; no production failure was reproduced.

## Image policy refinement

New publication and updates are limited to 64 images of at most 20,000,000 bytes
(20 MB) each. Capture, source image reads and publication authorization share this
policy. Keep the reader's former 512-attachment / 100 MiB object format bounds so
lowering admission limits does not break existing published links. History retains
its separate 32 MiB cap. Tests cover exact byte/count boundaries, legacy reads and
publication rejection; streaming size failures retain their size-specific reason.
