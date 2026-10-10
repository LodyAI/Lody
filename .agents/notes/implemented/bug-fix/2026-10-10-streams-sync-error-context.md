# Preserve safe context across Streams sync failures

Status: implemented
Translation: current

[中文](2026-10-10-streams-sync-error-context.zh.md)

## Abstract

`Streams sync failed: internal_error` lost the evidence needed to distinguish a request failure from a local storage or CRDT fault. Investigation of the old published packages reproduced both cases, then upstream changes introduced a safe provenance contract. Lody now consumes Repo 0.21.2 with Streams CRDT 0.16.2 and Client 0.9.0, projects that contract into local diagnostics, and formats failures across caller wrappers and synchronization reports. The projection preserves explicit retryability without logging raw exceptions or provider internals. Synthetic validation establishes propagation, not the cause of the original production incident.

## Original investigation

The original checkout pinned Repo 0.21.1, CRDT 0.16.1 and Client 0.8.0. Ten deterministic checks against those exact npm exports established these boundaries:

1. Client normalized its recognized timeout/protocol exceptions and globally treated TypeError as network failure. Ordinary Error became unknown, retaining a cause at that boundary.
2. CRDT sync caught upload, cursor, bootstrap/catch-up, CRDT and durability exceptions. Ordinary Error became internal_error with retryable false; TypeError became network_error. Conversion dropped ordinary causes and errno. A custom fetch throwing Error could therefore look identical to a local cursor fault.
3. Repo fromStreamsError reduced the failure to `Streams sync failed: <code>`, discarding status, request ID, timeout and provenance. Its coarse internal mapping also covered server_error and initial_sync_timeout; default retryability could overwrite the underlying false.
4. Single-transport Repo sync rethrew that error; total multi-transport failure wrapped it in RepoSyncError.report. Later Lody wrappers could not reconstruct the lost evidence. Wiring the old diagnostics callback alone was insufficient.

A cursor store throwing before fetch reproduced the incident message without any network request. HTTP 503 and initial-sync deadline fixtures reproduced separate information loss. The [serialization fix](2026-09-29-streams-sync-serialization.md) documents another historical local route to internal_error; none of these establishes the original incident's root cause.

## Decision and ownership

Streams now records provenance at the actual fetch, HTTP, deadline, cursor, CRDT and durability boundaries. Repo preserves its original discriminator, validated context, failure family and explicit retryability. Reviewed [Repo PR #144](https://github.com/loro-dev/loro-repo/pull/144) was merged at `e99f17b`; [release 0.21.2](https://github.com/loro-dev/loro-repo/releases/tag/loro-repo-v0.21.2) passed its official registry installation and 32 public API tests. Streams [CRDT 0.16.2](https://github.com/loro-dev/loro-streams/releases/tag/streams-crdt-v0.16.2) depends exactly on [Client 0.9.0](https://github.com/loro-dev/loro-streams/releases/tag/streams-client-v0.9.0).

Lody's shared tools explicitly select the documented scalar fields. CLI transport creation sends warn/error events to the existing logger; renderer composition sends them to its console sink. Error formatting in CLI, room waits, workspace runtime and session error descriptions reads the same projection. Ordinary errors keep existing formatting; routine successful synchronization stays silent. Bounded cause traversal handles wrappers and cycles, while reports retain registered transport identities.

The tools bind to each caller's Repo constructors. A standalone pnpm installation resolves different Repo instances for CLI's SQLite 13 peer and shared/renderer SQLite 12 peer; their error class identities are unequal. Defaulting to shared-package instanceof would silently miss CLI failures. Constructor injection preserves typed recognition without accepting arbitrary objects or guessing from messages.

CLI Streams composition explicitly registers that bound formatter with the generic error utility during module initialization. Importing Repo from the generic utility pulled Flock WASM into standalone process-worker bundles, which have no WASM loader. Keeping the runtime binding at composition avoids that dependency and leaves ordinary worker errors on their existing formatting path.

Safe detail includes code, failure family, retryability, room/transport, source, operation/stage, request operation, timeout phase/budget/elapsed time, HTTP status, constrained request ID and allowlisted errno when supplied. It excludes arbitrary message, stack, cause, body, headers, provider, token, key and URL query. Wrapper messages are not reproduced because they may carry those legacy payloads. Network evidence is described as a failed request, never a claim that the device is offline or backend is down; HTTP errors are described as response errors.

The catalog/lockfile uses the released versions and removes the obsolete Repo peer exception. Unrelated dependencies remain locked, including Roost's separate transitive Client 0.8.0. Local-only composition and disabled telemetry remain unchanged; the diagnostic helper performs no I/O and does not influence retry policy.

## Verification and limits

- Old-package investigation: 10 deterministic behavior checks passed.
- New Lody integration: 24 tests passed across shared fault fixtures, real CLI SQLite composition, renderer IndexedDB composition and room waits; 11 are newly added. Faults use synthetic messages/hosts, injected fetch and fake timers, without real network or sleep.
- The formal versions install with a frozen lockfile in a separate standalone clone; the nested checkout was not installed.
- The 61 existing manager/runtime/provider regression tests pass with test fixtures retaining the real Repo error exports. Streams RPC: 124 passed, 3 existing integration skips. Shared: 1,380 passed. Electron: 214 passed.
- Full type checks, type-aware static analysis (0 errors), internationalization and all boundary checks pass. CLI production bundle, published adapter/worker smoke checks, WASM copying and required formatting pass.
- Full test execution found an unchanged Roost signed-prefix timeout and nine Git/simulator fixture failures; all ten reproduce against unchanged source and the original published dependency versions. Two introduced collection/build failures were corrected by retaining real fixture exports and moving the formatter binding out of the generic worker utility. The final CLI subset passes 22 tests; the worker and owner bundles compile without a WASM loader. Native cloudflared IPC execution is limited by a timeout also reproduced on unchanged baseline code; no successful IPC execution is claimed.
- Documentation checks report the same 74 existing links into this checkout's uninitialized ACP submodules; this note pair and the new Spec have no link errors or protected-content changes.

No production logs, credentials, captured transcripts or incident causes were collected. No desktop/browser or deployed-service validation is claimed. Intent remains a [draft Spec](../../../../specs/streams-sync-diagnostics.md); implementation does not approve it.
