# E2EE core

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Start at the [reading guide](README.md) ([中文](README.zh.md)): it indexes the
whitepaper, Specs, decisions and this package's docs. Contract:
[foundations Spec](../../specs/e2ee-foundations.md). Rationale for the layout:
[service architecture note](../../.agents/notes/implemented/architecture/2026-10-16-e2ee-core-service-architecture.md).

## Structure

- Entries are exactly `.` (workflows), `./services` (ports), `./protocol`,
  `./host`, `./adapters/node-sqlite`, `./adapters/loro-streams` and the unstable
  `./internal`. Add an export only to the entry whose role it serves.
- Protocol code is pure (Result, plus Effect only for async crypto/verification)
  and imports no service or adapter. Workflows depend only on protocol code and
  `services/` tags; never on an adapter, Node API or SQLite. Adapters never decide
  authority. `./host` stays platform-neutral.
- Every remote system, platform capability and local store is a port. Do not
  add a workflow input that bypasses one (callbacks, paths, SDK objects).
- Workflows capture ports once with `own()`, declare complete failure unions,
  use `Effect.fn('@lody/e2ee-core/<Service>.<method>')` for public ledger/key workflow methods and
  `Effect.fnUntraced` internally, and never call `Effect.run*`.
- Close behavior is part of the contract: the admission gate (waits) only where
  native protection is borrowed; the close guard elsewhere.
- `KeyProtector` and `CandidateProtector` stay distinct ports: an unpublished
  rotation key is never protected through the installed-key capability.

## Documentation

- Every public export, namespace export and service member has JSDoc; `test/public-docs.test.ts` enforces it and that
  `docs/surface*.md` lists exactly each entry's exports. Presence is not quality:
  explain ownership, failure and retry semantics when applicable. Update the bilingual
  docs (`README*`, `docs/*`) in the same change as the behavior or surface.
- Port contracts live in their JSDoc and `docs/services.md`; backend rules in
  `docs/backend-guide.md` and `./host`. Keep them in agreement with the code.

## Invariants

- Preserve wire algorithms, domains and versions. Expected malformed input
  returns typed errors; never silently repair or downgrade bytes. Current format
  only: no legacy import, conversion or downgrade.
- Enforce CBOR limits before full expansion or copying; charge shared values by
  expanded size and reject cycles without unbounded traversal.
- Trusted genesis, resource, epoch, purpose and signer come from independently
  verified context; frame metadata is unverified. A valid signature establishes
  neither permission nor AEAD validity.
- Ed25519 requires canonical nonzero prime-subgroup A and R and S<L
  (`zip215: false`); fixed native Effects and private exact caches keep these checks.
- Byte wrappers own copies. Epoch keys have no public byte export; private keys
  stay with the platform. Every key copy and plaintext buffer is disposed with
  `acquireUseRelease`; native calls are uninterruptible.
- Ledger authority starts only at caller-pinned genesis plus expected head/count,
  or a module-created view. `VerifiedLedger` is the only source of ledger state
  for workflows; it remembers genuine views even when the pin write fails.
- Historical attribution and epoch packets come only from verified views.
  Revocation keeps old author identity but grants no current write permission;
  Recovery and Guest never write; a required rotation blocks new seals.
- Documents: current write/rotation checks precede encryption and repeat after
  signing; historical signature evidence is neither permission nor AEAD validity.
  Host admission (header 3 batches, position-bound header 4 snapshots) checks the
  genuine current writer, submitting signer, resource/model/epoch and the complete
  original before forwarding. Snapshot publication keeps exact signer/offset/digest
  identities; uncertain native outcomes stay Pending; one owner serializes writes.
- Durable workflows persist exact originals before any network step, retry
  those bytes, never re-sign, and keep results until explicit acknowledgement.
  Remote hints never end a task; only genuine ledger changes do.
- Local store mutations are atomic, verify their own write and binding in the
  same transaction, and never become authority. No transaction spans crypto or
  network I/O.
- Tests use fixed synthetic vectors, real SQLite and crypto, explicit signals;
  never captured transcripts, real keychains or private designs.

Module rules: [ledger](src/internal/ledger/AGENTS.md), [keys](src/internal/keys/AGENTS.md).
