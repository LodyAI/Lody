# E2EE core

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Start at the [reading guide](README.md) ([中文](README.zh.md)): it indexes the
whitepaper, Specs, decisions and this package's docs. Contract:
[foundations Spec](../../specs/e2ee-foundations.md). Rationale for the layout:
[service architecture note](../../.agents/notes/implemented/architecture/2026-10-16-e2ee-core-service-architecture.md).

## Structure

- Entries are exactly `.` (workflows), `./services` (ports), `./protocol`,
  `./host`, `./adapters/node-custody`, `./adapters/node-sqlite`, `./adapters/loro-streams`, `./cloudflare`
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

## Documentation

- Every public export, namespace export and service member has JSDoc; `test/public-docs.test.ts` enforces it and that
  `docs/surface*.md` lists exactly each entry's exports. Presence is not quality:
  explain ownership, failure and retry semantics when applicable. Update the bilingual
  docs (`README*`, `docs/*`) in the same change as the behavior or surface.
- Port contracts live in their JSDoc and `docs/services.md`; backend rules in
  `docs/backend-guide.md` and `./host`. Keep them in agreement with the code.

## Invariants

- Preserve wire algorithms, domains and versions. Expected malformed input
  returns typed errors; never silently repair or downgrade bytes. Ledger v1 freezes at
  the first production creation; after that it stays verifiable forever and
  `test/ledger-v1-vector.json` is never regenerated. Evolve only by
  [capability declaration or a new ledger](../../specs/e2ee-foundations.md#format-compatibility).
  Other formats are current-only: no legacy import, conversion or downgrade.
- Enforce CBOR limits before full expansion or copying; charge shared values by
  expanded size and reject cycles without unbounded traversal.
- Trusted genesis, resource, epoch, purpose and signer come from independently
  verified context; frame metadata is unverified. A valid signature establishes
  neither permission nor AEAD validity.
- Ed25519 requires canonical nonzero prime-subgroup A and R and S<L
  (`zip215: false`); fixed native Effects and private exact caches keep these checks.
  The WebAssembly verifier (`wasm/ed25519-strict`, rebuilt only by its `build.mjs`)
  is a fixed backend with the pure-JS fallback, never injectable, and must accept
  exactly what the pure-JS path accepts (`test/ed25519-wasm.test.ts`).
- Byte wrappers own copies. Epoch keys have no public byte export; private keys
  stay with the platform. Every key copy and plaintext buffer is disposed with
  `acquireUseRelease`; native calls are uninterruptible.
- Ledger authority starts only at caller-pinned genesis plus expected head/count,
  or a module-created view. `VerifiedLedger` is the only source of ledger state
  for workflows; it remembers genuine views even when the pin write fails.
- Historical attribution and epoch packets come only from verified views.
  Revocation keeps old author identity but grants no current write permission;
  Recovery and Guest never write; active devices may seal a retained published epoch.
  rotationRequired only advises administrators and must not block new seals.
- Documents: current write checks precede encryption and repeat after
  signing; historical signature evidence is neither permission nor AEAD validity.
  Streams snapshot and update reads authenticate historically admitted authors;
  revocation does not invalidate their signatures. Never-admitted keys fail closed.
  Host admission (header 3 batches, position-bound header 4 snapshots) checks the
  genuine current writer, submitting signer, resource/model/epoch and the complete
  original before forwarding. Snapshot publication keeps exact signer/offset/digest
  identities; uncertain native outcomes stay Pending; one owner serializes writes.
- Realtime content primitives compose only existing v0 purposes 7/8/9. Their
  resource and expected signer come from independently trusted caller context;
  opaque payload authentication grants no membership, freshness or execution
  authority. Keep application body codecs, target binding and send/rotation gates
  in the authorized integration; never expand `sealDocument` for these purposes.
- Machine-sharing policies remain independent of ledger records. Execution requires
  the current machine owner's active personal-device policy signature; historical
  chain verification grants no execution authority. Generation evidence must qualify
  the current machine through ledger-included initial/replacement admissions; removal
  starts a new signed resource, while atomic replacement preserves its root.
  Hosts own latest-head freshness,
  resource-bound durable pins and actual local-project resolution. See the
  [sharing proposal](../../.agents/notes/proposed/architecture/2026-10-28-e2ee-machine-sharing.md).
- Key rounds attempt receive and distribution independently; report each outcome
  and retain the failed phase's retry cursor. Unknown senders request ledger refresh.
- Durable workflows persist exact originals before any network step, retry
  those bytes, never re-sign, and keep results until explicit acknowledgement.
  Remote hints never end a task; only genuine ledger changes do.
- Local store mutations are atomic, verify their own write and binding in the
  same transaction, and never become authority. No transaction spans crypto or
  network I/O.
- Tests use fixed synthetic vectors, real SQLite and crypto, explicit signals;
  never captured transcripts, real keychains or private designs.
- TypeScript Worker fixtures preload `test/worker-loader.mjs` to register tsx
  inside the worker; `--import tsx` alone does not resolve their imports on Node 22.

Module rules: [ledger](src/internal/ledger/AGENTS.md), [keys](src/internal/keys/AGENTS.md).
