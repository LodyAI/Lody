# Storage-owned snapshot service for session-data

Status: implemented
Translation: current

[中文](2026-09-12-storage-owned-snapshot-service.zh.md)

## Abstract

PR #376's stored-copy capability becomes a storage-owned port service instead of a
module-level handle passed through the CLI facade. `SessionData.snapshots` issues
opaque, branded `SessionSnapshot` handles bound to the issuing store and `sessionId`;
callers pass only a selection plus the handle, `release` invalidates it idempotently,
foreign/forged handles throw `cross_store`/`invalid_snapshot`, and closing the source
store turns every outstanding handle into `source_closed`. `snapshot.read()` is the
handle's own full, detached stored read, and `copyFrom` admits same-backend cross-store
handles, so the real fork flow runs capture-on-source/copy-into-target through the port.
The guarded editable-tail replacement and the no-gap composed history import also moved to
port commands. Provenance stays in `history-writer.ts`; the adapters only scope handles.
The in-memory double captures and releases honestly but declares `capabilities.copy =
false` and returns `rejected('unsupported')` for copy, tail replacement and import, so no
second backend can pretend those capabilities.

## Design

```text
business caller → data.snapshots.capture() → SessionSnapshot (branded, per-store)
business caller → snapshot.read()           → full detached stored turns (export/replay/hash)
business caller → target.snapshots.copyFrom(snapshot, selection) → SessionCommandResult
                        ↑ selection only; the stored payload never crosses the port
business caller → data.commands.replaceEditableTail({expectedUserTurnId, expectedForkTurnId, …})
                        → { previousUserTurnId, rollback }
business caller → data.commands.applyHistoryImport({update, createCursor})
store teardown   → SessionDocument.destroy → snapshots.closeSource()
```

`session-data/snapshot.ts` declares the brand symbol without exporting it and mints
handles through an internal factory, so no JSON value or plain object satisfies the
type; runtime authenticity is a `WeakMap` from handle to an issuer record (store token,
backend kind, this capture's payload, the issuing store's live set and closure state),
never a shape check. `release` stays issuing-store-only; `copyFrom` validates forged →
`invalid_snapshot`, other backend → `cross_store`, source closed → `source_closed`,
released → `released`, and then copies through the shared writer, which still prepends
the business-authored selection, rejects colliding ids as `rejected('conflict')` before
any mutation, and retains unchanged opaque content from the captured source. Cross-store
copy is safe because the writer's module-level provenance map accepts a snapshot captured
by any writer over any doc; the port merely narrows it to same-backend handles.

The Loro adapter implements `snapshots` over the shared `HistoryWriter`'s
`capture()`/`copyFrom()`, `read()` over the captured writer snapshot's detached getter,
and the two guarded commands over the same writer. `replaceEditableTail` runs the shared
`planner.ts` rule inside the writer's conditional commit and returns the writer's
compensation closure plus the resolved `previousUserTurnId`; a domain refusal
(`invalid_input`/`active_goal`/`stale_boundary`) and a `HistoryWriteError` are both
pre-write rejections that prove nothing was applied. `applyHistoryImport` binds the writer
update, `writer.readStored()` and the cursor creation in one synchronous block, writing the
cursor through a construction-time control-plane accessor (`historyImportCursor`, wired by
`composeSessionData` to the control Mirror) — there is no await gap for a peer edit to fall
into. The adapter has no lifecycle of its own, so the snapshot service exposes an internal
`closeSource()` and the CLI's existing teardown path (`SessionDocument.destroy`) calls it;
no new lifecycle was invented.

The memory double mints and releases real handles with the same validation codes, but
declares `capabilities.copy = false` and answers a valid handle's `copyFrom` — and both
guarded commands — with `rejected('unsupported')` instead of claiming rules it does not
implement.

## Consumers

Fork captures on the source (`sourceDoc.sessionData.snapshots.capture()`), reads the
clone boundary with `snapshot.read()`, and copies into the target via
`targetDoc.sessionData.snapshots.copyFrom(...)`, mapping a rejection to
`TARGET_WRITE_FAILED`. Edit-and-resend calls
`sessionDoc.sessionData.commands.replaceEditableTail({ expectedUserTurnId,
expectedForkTurnId, replacement, fallbackGoal })` and maps a `rejected` result
(`active_goal` → `ACTIVE_AUTOMATION`, `stale_boundary` → `STALE_USER_TURN`) to its
failure response, keeping the returned compensation for a failed meta commit.
Local-project history sync drives
`sessionDoc.sessionData.commands.applyHistoryImport(...)` at all three sites through one
`applyBoundHistoryImport` helper. No business code calls the raw
`SessionDocument.captureStoredHistory/copyStoredHistory` facades anymore; those raw-writer
facades and `updateHistoryAndCursor` remain only as back-compat surface (the latter now
delegates to the port command, reconstructing a `HistoryWriteError` on rejection).

## Trade-offs

- Cross-store `copyFrom` is admitted only between stores of the same backend (Loro);
  memory-to-Loro or Loro-to-memory is `cross_store`. Fork therefore goes through the
  port, while the port's handle scoping stays meaningful.
- The public handle/service methods are `Promise`-returning: `capabilities` and `release`
  stay synchronous, while `capture()`, `read()` and `copyFrom()` are `async`. This was
  revised from the initial synchronous signature so a database-backed store can capture,
  read and copy without blocking the caller; the Loro adapter still performs its capture,
  detached read and copy synchronously inside the async body (no `await` gap), so its
  atomicity is unchanged. The memory double only marks its methods `async`; its body adds
  no controllable delay.
  `copyFrom` does not run the adapter's async `afterAccept` hook; the writer preflights
  every rejection before mutation, so an accepted receipt still means the copy is applied.
- `replaceEditableTail` reports a domain refusal as `rejected` instead of propagating a
  thrown business error: the command owns the eligibility/goal rule, so the adapter can
  name the reason (`active_goal`/`stale_boundary`/`invalid_input`) and the caller maps it
  without message matching. This replaced the earlier arbitrary
  `updateHistoryWithRollback(update)` callback entry, whose business throw carried the
  reason as text.
- `replaceEditableTail`'s `rollback` is `() => Promise<void>`, not a synchronous closure.
  The compensation undoes a write the caller already treated as committed, so a backend may
  need to reach durable storage before the caller restores its meta and persists the
  rollback; an earlier synchronous signature let those two interleave. The Loro adapter
  keeps its conditional restore synchronous inside the async body, and a rejecting
  compensation surfaces to the caller's existing restore-error path instead of being
  reported as success.
- The receipt kind union gained `'copy'`, `'replace-editable-tail'` and `'import-history'`;
  no consumer switches exhaustively on it.

## Verification

`tests/session-data-contract.ts` runs the new cases for both backends, branched on
`data.snapshots?.capabilities.copy`: forged JSON-shaped handles are rejected, release is
idempotent and released handles are refused by `read`/`copyFrom`, the Loro backend copies
a cross-store selection retaining a legacy subfield the caller never authored and
rejecting colliding ids, the writer-owned rollback/import commands succeed on Loro, and
the memory double returns `rejected('unsupported')` for copy, rollback and import while
still throwing for foreign handles. The Loro suite covers `source_closed` after
`closeSource()` (same-store and cross-store) and the cursor round-trip of
`applyHistoryImport`. CLI suites for fork, edit-and-resend and history import were
rewired to the port and assert the same behavior; a memory-backed import is explicitly
rejected in `local-project-history-sync-service.test.ts`. Full `packages/shared` and
`apps/cli` typechecks and test suites pass with a redirected `HOME`.
