# Local-first session sending

Status: implemented
Translation: current

PR: [#1104](https://github.com/LodyAI/Lody/pull/1104)

[中文](2026-09-29-local-first-session-send.zh.md)

## Abstract

The send journal treated a missing remote receipt as unfinished sending, blocking
archive even when a message was already stored locally. Ready messages now write
history and activation locally, while the outbox synchronizes in the background.
Archive pauses durable drafts and ordinary exit retains accepted input without
waiting for the target. Attachment completeness and uncertain guide reconciliation
remain necessary; packaged-device acceptance has not been run.

## Decision and evidence

This partially replaces the [deferred attachment design](../../proposed/architecture/2026-09-14-deferred-attachment-send.md).
The current [Spec](../../../../specs/session-files.md#local-first-sending) remains draft.
The previous `saved → prepared → committed → delivered` workflow also waited for
target synchronization before repairing interrupted local writes. The activation
pointer was written during delivery, making a locally written turn depend on a
later delivery task to become discoverable by the daemon.

New records skip `prepared`. Version 4 marks local write intent; after the live
SessionData write, activation and local flush, version 2 marks background delivery.
The original persisted replica is merged before identity reconciliation, including
delivery from another window. Version 1–3 records remain readable, and older
clients refuse version 4. The outbox remains because dropping it would lose the
cross-window recovery reference and accepted attachment sources.

An interrupted intent missing from local history still needs target reconciliation
in background recovery: it may have reached a peer before local persistence failed.
Normal sends and recovery of a locally present turn have no such network gate.

Creation metadata is published locally at admission. Archive retains and pauses
unfinished inputs; restore resumes them. Delete removes the matching inputs and
joins writers before publishing the tombstone. Startup, online/focus and existing
presence reconnection events trigger one workspace recovery pass; there is no
per-message timer or additional transport. Guide uncertainty still prevents replay.

## Validation and limits

Behavioral tests exercise local activation before synchronization, offline retry
with one turn, old-record recovery, archived draft retention/restoration, archived
history synchronization without dispatch, and deletion with an outbox entry.
Existing attachment and native/editor exit tests remain in the owning suites.
The components type check was attempted with locally available dependencies; missing
packages and mismatched loro-repo/ACP declarations prevent a clean full check.
Documentation checking also reports links into uninitialized ACP submodules.
The focused five-suite run passes 127 tests. `pnpm format` passes; `pnpm check`
stops in shared ACP type checking because the available extension declarations
lack the current subagent exports. No packaged desktop/mobile acceptance was run.
