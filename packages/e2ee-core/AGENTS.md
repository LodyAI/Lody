# E2EE core

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Start at the [reading guide](README.md) ([中文](README.zh.md)): it indexes the
whitepaper, Specs, decisions and this package's docs. Contract:
[foundations Spec](../../specs/e2ee-foundations.md). Rationale for the layout:
[service architecture note](../../.agents/notes/implemented/architecture/2026-10-16-e2ee-core-service-architecture.md).

## Structure

- Entries are exactly `.` (workflows), `./services` (ports), `./protocol`,
  `./host`, `./adapters/node-custody`, `./adapters/browser-crypto`, `./adapters/browser-custody`, `./adapters/indexeddb`, `./adapters/node-sqlite`, `./adapters/loro-streams`, `./cloudflare`
  (bundle-time WebAssembly for workerd) and the unstable `./internal`. Add an export only to the entry whose role it serves.
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
- Before changing client custody or installation, read the [client custody Spec](../../specs/e2ee/client-custody.md).
  Its new ports do not enable a host; native bridges stay scoped to protection,
  and installation receipts never grant ledger authority.
  Replacement archives the old receipt atomically without resetting the slot or
  its revision. Client wrapping uses DAG-CBOR text AAD; never expand the ledger
  CBOR subset to encode it. Shared bytes are pinned by `test/client-custody-vector.json`.

## Documentation

- Every public export, namespace export and service member has JSDoc;
  `docs/surface*.md` lists each entry's exports. Presence is not quality:
  explain ownership, failure and retry semantics when applicable. Update the bilingual
  docs (`README*`, `docs/*`) in the same change as the behavior or surface.
- Port contracts live in their JSDoc and `docs/services.md`; backend rules in
  `docs/backend-guide.md` and `./host`. Keep them in agreement with the code.

## Invariants

Before changing protocol, ledger, custody, keys, persistence or their tests, read
[the core invariants](INVARIANTS.md). Those rules apply throughout this package.

Module rules: [ledger](src/internal/ledger/AGENTS.md), [keys](src/internal/keys/AGENTS.md).

Product content seals prefer installed current keys. Only genuine missing-key
results permit retained published keys inside the durable fifteen-minute first-observation
budget; uncertain timing fails closed. Membership/device/role checks remain mandatory.
See the [owner tradeoff](../../.agents/notes/implemented/architecture/2026-10-27-e2ee-epoch-receive-barrier.md).

Immutable recovery-package reads borrow independent short-lived master-key copies;
never hold the index mutex across their network waits. Vault close stops new reads
and drains admitted reads before returning; index mutations retain their mutex and CAS.

The reference mailbox limits each sender to 16 non-rejected envelopes per current
slot revision; repairs retain historical originals and rejected-digest entries.

Recovery admission may use the highest authenticated committed epoch and its history,
or the authenticated recovery identity at epoch zero. Report partial key recovery;
never equate restored governance with current-key readiness. New owner transfers
require a successor personal device, and last-personal revocation requires explicit
recovery-loss confirmation in the workflow. Preserve v1 replay rules.
