# `@lody/shared` session-data — domain ports

`CLAUDE.md` is a symlink to this file. Parent `AGENTS.md` files apply.

The CRDT-neutral seam between session business code (React UI, CLI, MCP) and one
storage implementation. Public DTOs live in `domain.ts` and MUST NOT import the
storage schema; `types.ts` MUST NOT name Loro, Mirror, a CID, a container id or a
storage offset.

- **One shared writer.** `createLoroSessionData` consumes the entrypoint's
  `HistoryWriter` (`mirror.historyWriter`); never construct a second writer, and never
  re-implement parsing, container diffing, rollback or stored-copy rules. Domain
  command rules live once in `planner.ts` and are applied by both the Loro adapter and
  the in-memory double.
- **Explicit field changes.** `set(value)` or `clear`; never `undefined`-means-delete
  across a JSON/worker boundary. `items`/`id` are edited whole-entry.
- **Phased results.** `accepted` (retrying duplicates), `rejected` (validated and
  refused before storage; safe to fix and retry) and `indeterminate` (never auto-retry).
  An accepted write whose post-accept side effect failed reports `postAcceptError` and
  MUST NOT be re-issued or reported as a pre-write rejection. Validate input and locate
  the target before mutating; a throw after the writer is invoked is `indeterminate`,
  not a rejection.
- **Durability is separate** from acceptance and remote sync, and is a construction-time
  choice: a caller passes a real local barrier (`repo.flush`) or explicitly declares
  `durability: 'unavailable'`. `waitDurable` rejects with
  `SessionDurabilityError('unavailable')` when there is no barrier, and with
  `'invalid_receipt'` for a receipt it did not issue; a receipt is an opaque capability,
  never a caller-shaped object. Never treat an in-memory accept as persisted.
- **Async windowed reads.** `count`, `readAt`/`readTurn`/`readRange`, `readDirectory`
  (identity/state only, never bodies), `readAll` (one consistent detached full read) and a
  gap-free `observe` whose initial directory is captured at the same point the listener goes
  live. `changed` carries a raw range plus `structural: true` only for a membership/order
  change; a content-only change omits it so a consumer fences the affected turn without
  cancelling unrelated in-flight reads. Read states distinguish
  missing/invalid/unavailable (`incomplete`/`unsupported`/`failed`). Identity lookups
  read `id` shallowly and materialize only the target body.
- **Display paging is business logic.** `pageVisibleTranscript` scans raw rows through the
  reader, counts displayable turns, keeps the cursor a raw position and never reports an
  empty tail as the end. A caller-supplied visibility predicate stays on this side of the
  boundary, not in the port.
- **Bound ACP batches are one domain command.** `applyAgentBatch` rewrites only the
  located turn for an entry-bound text/thought batch, keeps whole-history routing for a
  mixed tool/subagent batch that may belong to an older turn, and creates a missing bound
  target under the caller's id. Both adapters apply the same shared notification/content
  planners; the caller never passes a JSON op list.
- **Storage-owned snapshot service.** `data.snapshots` is the port's opaque-handle
  stored-copy service. `capture()` must be the shared writer's `capture()` (Loro) or an
  honest store snapshot (memory) — never a stitched read of a changing page.
  `snapshot.read()` is the handle's own full, detached stored read (export/replay/hash
  use it instead of stitching paginated reads). `release` is idempotent and
  issuing-store-only; forged/foreign/released handles throw `SessionSnapshotError` with
  the matching code, and `source_closed` applies once the issuing store closes
  (`LoroSessionData.snapshots.closeSource()`, the store teardown hook called by
  `SessionDocument.destroy`). `copyFrom` admits same-backend cross-store handles (the
  fork flow: capture on the source, copy into the target) and rejects a different
  backend with `cross_store`. Provenance stays in `history-writer.ts`; adapters only
  scope handles to the issuing store identity + `sessionId`. A backend without stored
  copy declares `capabilities.copy = false` and returns `rejected('unsupported')` — never
  a false capability.
- **Writer-owned guarded operations.** `commands.replaceEditableTail` replaces the editable
  tail user turn from explicit domain inputs (`expectedUserTurnId`, `expectedForkTurnId`,
  `replacement`, `fallbackGoal`): the eligibility rule and the active-goal guard live once in
  `planner.ts` (`resolveEditableTail` / `planEditableTailReplacement`) and are re-applied
  against the history read inside the store's commit, so a tail that moved after the caller's
  own check is `rejected('stale_boundary'|'active_goal')`, never overwritten. The accepted
  result carries `previousUserTurnId` (the caller's meta commit needs it) and a range-scoped
  `rollback` that is `() => Promise<void>` and retains rows appended after the replacement;
  the caller MUST `await` it (and handle rejection) before persisting its own follow-up
  state, because the compensation may reach durable storage. `commands.applyHistoryImport`
  (imported history write + stored snapshot read + cursor creation in ONE synchronous block,
  no await gap; the cursor setter arrives as a construction-time control-plane accessor) is
  still a caller-supplied update/cursor callback. Both are port commands over the one shared
  writer; a backend without the rules (memory) rejects `unsupported` instead of faking them.
  Business code never passes a raw writer callback or names `SessionHistoryInput`, and never
  calls the `SessionDocument.captureStoredHistory` / `copyStoredHistory` /
  `updateHistoryAndCursor` back-compat facades.
- **The in-memory double** exists to prove async reads/writes and real consumer contracts;
  it is not a second copy of domain rules. Both backends run
  `tests/session-data-contract.ts`, and a real consumer runs against the double in
  `packages/components/tests/session-data-consumer.test.ts`.
