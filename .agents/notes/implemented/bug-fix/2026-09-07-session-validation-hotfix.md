# Separate session availability hotfix from the writer refactor

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/463

[中文](2026-09-07-session-validation-hotfix.zh.md)

## Abstract

Full-state Mirror validation can reject a valid new message because an unrelated
old history item is unknown or malformed. Temporarily disabling `validateUpdates`
at the renderer and CLI session construction sites restores this write path without
changing writers or storage. This removes a runtime safety net for new local data;
it does not prove malformed writes impossible or repair incompatible readers.

## Decision and scope

- Based independently on `main@d366a5a6`, not on [#460](https://github.com/LodyAI/Lody/pull/460).
- Only the two session Mirrors bypass full-state validation. Other Mirrors and
  explicit external message parsers retain their existing checks.
- No schema, dependency, history-copy, rollback, persistence, or transport changes.
  No new migration or cleanup; existing initialization behavior remains unchanged.
- Shipping the writer refactor as an urgent prerequisite was rejected: review found
  fork initialization and edit-and-resend rollback interactions needing more work.
  Keep #460 separate until fixes and independent multi-round review cover real
  subscribers, asynchronous failures, and cross-version stored content.
- Re-enable or replace validation only with a reviewed changed-input boundary,
  not simply after a calendar deadline. Older unpatched clients remain affected.

## Evidence and limits

Synthetic real-Loro tests compare validation enabled/disabled, live import and
snapshot reopening, append and text updates, old container identity, and concurrent
opaque edits. A construction-site test covers both production sites and excludes
non-session Mirrors. Explicit parser tests still reject unknown and malformed inputs.
These tests do not exercise deployed applications, disk-failure recovery, or 3000 turns.
See [temporary contract](../../../../specs/session-validation-hotfix.md).
