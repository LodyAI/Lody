# E2EE core

Experimental, not product E2EE. Contracts: [content v2](../../specs/e2ee-content.md), [ledger](../../specs/e2ee-ledger.zh.md),
[README](README.md). `src/legacy.ts` JSON/hex is test-only; never re-export it.

## Required source style

- Use **Effect 4.0.2**, catalog `e2eeEffect`; keep default v3 and never mix majors.
- `pure/`: deterministic values/typed `Result`; no I/O, ambient state, clocks,
  randomness, logging or input mutation. Only unobservable scratch mutation.
- `workflows/`: inert `Effect<A,E,R>`; declare Services for storage/network/crypto/
  entropy/clocks/environment/process. No eager execution, hidden Live defaults or
  runtime starts. Use `Effect.fromResult`.
- `platform/`: thin Services/Layers for external APIs; policy/state transitions
  belong in pure first, workflows second, never platform.
- Expected failures use Result/Effect, never throw. Only fatal defects may throw;
  never turn defects/interruption into ordinary failures or Pending.
- Inject Effect logging/tracing; platform owns sinks, pure returns diagnostics.
  No console, ambient loggers or secret logging. Existing temporary bridges allow
  no additional exceptions.

## Protocol and integration invariants

- Public entrypoints are mapped in README. Never accept `verified=true`, expose
  verified internal state, or construct a ledger view from unverified state.
- Org identity is the genesis record hash. `protocolVersion=1` only in genesis.
  Ordinary records omit Org ID, sequence, and generic operation IDs. Wire is
  `@ipld/dag-cbor` fixed arrays; keys, signatures, and hashes are raw bytes.
- `Ledger.verify`/`extend` are pure and immutable: parse, hash, verify all
  signatures (including nested proofs), then replay policy. Never skip invalid
  records or grant unverified authority. The 10k/100ms target is withdrawn.
  Verification defaults to sequential; Node workers need explicit
  `createNodeSignatureVerifyExecutor`. Inject entropy/clocks/timers/executors.
- Snapshot join (§6.1, DEC-001): out-of-band genesis, endorser, attested head
  and endorser signature; only a current Owner/Admin personal device may endorse.
  Bind complete state, replay facts, genesis, position and head, not head alone.
  Verify increments; full replay is optional audit. Comparison detects divergence,
  not freshness or honest history. Refresh may skip prefix until
  observing/extending the attested head; thereafter wrong parents, foreign genesis
  or duplicate known hashes fail closed without cursor advance. Unknown prefix,
  even junk followed by an empty final page, must not become up-to-date success.
- Persist exact pending bytes before CAS. Conflicts never re-sign; retry the
  same bytes. Each transaction owns its state; save and publication are one
  narrow uninterruptible step. `./effect` has the intent client; old `./ledger` submit/resume
  delegate to the same `workflows/ledger-engine.ts`. No second submit path.
  Verify/extend live only in `workflows/verification.ts`; `./ledger` runs them
  via `ledger/compat.ts` (no own replay/cache); `check:effect-boundaries
--complete` guards both. Malformed pages must not become Pending.
- Epoch envelopes require `canSendEpoch`, an admitted recipient, current epoch and
  `commitEpochKey`; install into the verified slot, never a later epoch. Active
  personal/machine devices (including Guest) forward; R only receives. Gateways
  use `assertEpochStreamAppend` (one envelope, authenticated sender). Recover history
  only through `recoverLedgerHistory` on a verified ledger; installed keys never change.
- Central delivery is explicit finite rounds, never hidden timers/runtimes. Derive
  targets from the client's verified ledger; server lists grant no authority.
  Preserve exact outbox bytes and `Observed` = stored, not installed. Persist receive
  context before keyring writes; reports bind exact source and repair revision.
  Commit task termination/result together; only application acknowledgement consumes
  results. Mailbox/index atomicity is local, never a cross-stream permission guarantee.
- `possess/v2` binds target membership from the actor's preceding verified state;
  check during replay even with workers. Reject v1; no migration/re-signing.
  No device management flag: management = active personal ∩ current Owner/Admin;
  roles apply to all personal devices. Reject old 6-element admitDevice and
  5-element snapshot device rows.
- Roles owner/admin/member/guest; guest read-only; machines have no Org
  management. Device revoke is this-Org and the named device only. Owner
  transfer is unilateral `[6, successorMembershipId]`; predecessor becomes
  Admin. The Owner and any successor keep a personal device or R.
- Recovery device R receives epoch keys and may admit that user's personal
  devices; those follow the user's current role like any personal device. Passkey/file wrap the same R independently; leaking R
  requires replace-R, update entries, and per-Org revoke-old-R plus rotation.
- Signing keys must be canonical nonzero prime-subgroup Ed25519 points.
  Verification uses pinned noble-ed25519 with `zip215: false` and explicit
  subgroup checks for A and R. Only native signing handles private keys.
- Device storage stays in Electron main. Opt-in Streams adapters use the supplied
  SDK with explicit streams/anchors. Tests use synthetic fixtures and real crypto.
- Content uses XChaCha20-Poly1305, HKDF-SHA-256 and strict Ed25519 with verified
  Org keys and independent scope. `inspectContent` is UNVERIFIED. Preserve original
  history identity or return device-only when missing; never reattribute keys.
  `streams-content.ts` uses SDK `seal`/`open`; external AAD binds AEAD/signature,
  never plaintext. Header 3/4 rejects old 1/2. Only active personal/machine writers
  may write, never Guest/R; honest
  seals need `maySealNewContent` (none while `rotationRequired`). Bind genesis, resource,
  kind/model, epoch and opaque continuation offset. `./snapshot-admission`
  requires current write permission, submitter/signing-device binding and the
  original 15-minute lease, rechecked after async verification immediately before
  storing exact bytes, never restarted. Exact retries are idempotent for the
  signing device only; hosts admit only offsets within the stream tail and never
  republish a non-current result. Different bytes at an admitted offset fail.
  Decryption, offset, old head or self-declared time cannot prove admission.
  Production JWT/gateway remains unimplemented; keep product E2EE off.
- `snapshot-publication-store.ts`: synchronous atomic port; memory default is not
  durable. Node store only via `./node-snapshot-publication-store`; only
  `{ create: true }` creates SQLite. Verify outside the lock; recheck inside before
  the atomic commit. Busy retries unchanged input, never steals locks.
- `streams.ts` uses the pinned SDK read/`appendCas` APIs and length framing.
  Never invent offsets, fall back to ordinary append, or auto-re-sign. HTTP
  reads can split frames; checkpoint only complete frames/pages.
- Node stores (`./ledger-node`, `node-store.ts`, `./effect/platform-node`) require
  application-owned local files and SQLite EXCLUSIVE locks; never export them from
  root. Only explicit create initializes storage; open fails on missing/foreign/
  corrupt journals. Experimental journal/outbox formats are not V4; pure codecs
  preserve v0/v1 bytes.
- Legacy JSON/hex (`team.ts`, `KeyDelivery`, `EpochPublisher`, v3 genesis):
  still reject old v1/v2 unchanged; `canManage` is explicit; machines false;
  admit/cancel consume `(identity, requestId)` permanently; expiry is checked
  at trusted atomic admission, never historical replay; never re-sign pending;
  `ControlFreshnessLease` is not a JWT. History-stream publishers are not the
  ledger history-packet path.
- `node-device-store.ts`: never regenerate on load failure; load never creates
  storage; no private-key IPC. R import rejects mismatched key pairs.
  `node-received-key-store.ts` saves original HPKE ciphertext. Disk presence is
  not authority.
