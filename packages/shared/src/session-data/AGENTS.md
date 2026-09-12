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
- **Durability is separate** from acceptance and remote sync. `waitDurable` rejects with
  `SessionDurabilityError('unavailable')` when the store has no barrier, and with
  `'invalid_receipt'` for a receipt it did not issue; a receipt is an opaque capability,
  never a caller-shaped object.
- **Async windowed reads.** `count`, `readAt`/`readTurn`/`readRange`, `readDirectory`
  (identity/state only, never bodies) and a gap-free `observe` whose initial directory is
  captured at the same point the listener goes live. Read states distinguish
  missing/invalid/unavailable (`incomplete`/`unsupported`/`failed`). Identity lookups
  read `id` shallowly and materialize only the target body.
- **Display paging is business logic.** `pageVisibleTranscript` scans raw rows through the
  reader, counts displayable turns, keeps the cursor a raw position and never reports an
  empty tail as the end. A caller-supplied visibility predicate stays on this side of the
  boundary, not in the port.
- **The in-memory double** exists to prove async reads/writes and real consumer contracts;
  it is not a second copy of domain rules. Both backends run
  `tests/session-data-contract.ts`, and a real consumer runs against the double in
  `packages/components/tests/session-data-consumer.test.ts`.
