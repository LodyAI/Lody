# Block the desktop after disk-full write failures

Status: implemented
Type: feature
Translation: current
PR: [#1829](https://github.com/LodyAI/Lody/pull/1829)

[中文](2026-10-22-desktop-disk-full-guard.zh.md)

## Abstract

A full disk can prevent Lody from persisting data while leaving the interface usable without explaining the failure. The desktop now observes renderer and local CLI repository write failures, confirms low space, and displays a dialog that cannot be dismissed. Users can free space and restart, or quit; background agents continue until those actions. The observer API comes from the released `loro-repo` 0.25.0. Real storage fault tests exercise the signal paths; this has not been tried with an actual full filesystem.

## Decision and trigger

The owner selected **write failure plus low-space confirmation**, with **interface-only blocking**. A low-space reading alone never blocks, and a storage failure with adequate space does not block. This is separate from the retry/bandwidth fixes discussed in [Lody #1820](https://github.com/LodyAI/Lody/pull/1820); this change does not include those upstream synchronization fixes.

Main reads the Electron profile and Lody data directory, which may be on different volumes. It selects the least headroom relative to a requirement of 2% of total capacity, clamped to 5–20 GiB. Queries are coalesced and throttled to one per ten seconds. An unreadable directory is skipped for initial detection; no readable volumes means no blocking.

Once blocked, the guard remains blocked for the process lifetime. Restart requires successful readings of all data volumes and at least 1 GiB above their requirements. A failed check keeps the dialog and allows retry or quit. Restart and quit use the existing application quit barrier, preserving unsaved-editor vetoes and CLI shutdown ownership. No automatic restart, cache deletion or background-agent suspension is introduced.

## Signals and ownership

```text
Renderer IndexedDB write failure → storageGuard.reportWriteFailure IPC ┐
Local CLI SQLite write failure → runtime issue → desktop observer      ├→ main checks space
                                                                     └→ blocking dialog in product windows
```

- `providers/workspace-repo-storage.ts` creates the native IndexedDB adapter with `onWriteFailure`. Electron reports through the existing IPC bridge, coalescing concurrent reports and observing IPC rejection. Browser consumers do not call Electron. The adapter retains batch, writer, migration, index and checkpoint capabilities.
- CLI `createCliSqliteRepoStore` accepts the callback passed from Fleet through Lody and the document manager. `CliRuntimeStateReporter` stores one bounded `storage_write_failed` issue, using the existing additive runtime issue protocol. Reports contain no raw errors, paths or document contents. No cloud transport carries the signal.
- Main's `storage-guard-cli.ts` observes newer local runtime issues; the application observes rejected checks. `storage-guard.ts` owns the process-lifetime state and coalesced disk query. Renderer listeners are unsubscribed on unmount. A late initial snapshot cannot overwrite a newer push.
- `StorageFullGuard` mounts outside the runtime error boundary. Its controlled alert dialog has no dismissal path and explains that restarting or quitting stops background agents.

The observer does not own a Repo or its shutdown. Writes retain their original rejection and retry semantics; the guard introduces no storage fence. The existing Promise IPC and quit boundaries remain in place, rather than extending the unfinished application/CLI Effect chain for a notification callback.

## Storage observer source

The write-failure observer comes from the released `loro-repo` 0.25.0, adopted in [#1831](https://github.com/LodyAI/Lody/pull/1831) with the [storage recovery release](../bug-fix/2026-10-23-storage-recovery-release-adoption.md); the earlier `loro-repo@0.24.0` backport patch of upstream #164 is removed and the integration tests are retained.

The hook observes failed public writes, including batches, migration state, cursor indexes, checkpoints and SQLite durable cursor writes. Nested tracked writes report the same error object at most once. Read failures and logged load-time consolidation failures do not report. A throwing listener is isolated; busy errors report after the existing retry budget, with no new retry loop.

An adapter Proxy or incomplete wrapper was rejected because it could hide optional native capabilities.

## Verification and limits

- Main tests cover thresholds, multiple volumes, burst coalescing, sticky blocking, unreadable disks and restart refusal. IPC policy tests keep the new service registered and allowlisted.
- Renderer tests drive the real guard and dialog, including Escape, restart/quit, initial-state ordering, and check errors. A real fake-indexeddb adapter with an injected quota exception triggers the dialog while the write still rejects; an abort after the underlying request succeeds also triggers it, and read failures do not.
- CLI tests constrain a real SQLite connection with `max_page_count`, observe `SQLITE_FULL` through the runtime reporter and desktop observer, and verify that the store remains usable after the restriction is removed. Both ESM and CommonJS entries exercise nested write capabilities and error identity. The SQLite pending-update restart regressions from the [owning adoption note](../../implemented/bug-fix/2026-10-22-loro-pending-persistence.md) also passed with the then-patched package.
- Remote CLI disks, non-repository stores, and storage failures without low-space confirmation are outside this guard. No real full-disk or all-platform packaged Electron run has been performed; space thresholds are a policy estimate, not proof of the backend failure cause.
