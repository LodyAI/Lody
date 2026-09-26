# E2EE core

Experimental primitives, not enabled product E2EE.
Binding surface: [ledger spec](../../specs/e2ee-ledger.zh.md) and
[README.md](README.md). JSON/hex control-log lives in `src/legacy.ts` for
in-package tests only; do not re-export it.

## Required source style

- **Effect v3 only**: exact workspace catalog pin (currently `3.18.4`).
  No v4/prereleases without approval.
- `pure/`: deterministic values or typed `Either`; no I/O, ambient state,
  clocks, randomness, logging or input mutation. Only unobservable local scratch
  mutation is allowed.
- `workflows/`: `Effect<A, E, R>` descriptions with declared Services for ALL
  side effects and external/global dependencies (storage, network, crypto handles,
  entropy, time, environment, process). No eager execution, hidden Live defaults
  or internal runtime starts.
- `platform/`: thin Service implementations/Layers; direct external API access
  belongs here or in composition. Concentrate complexity in pure first, workflows
  second; keep domain policy/state transitions out of platform.
- No expected `throw`: pure returns typed `Either`; workflows use typed Effect
  failures. Only unexpected fatal defects may throw. Never disguise defects or
  interruption as ordinary failure or Pending.
- Use Effect logging/tracing and injected Services, never `console` or ambient
  loggers. Platform/composition configures sinks; pure returns diagnostic data.
  Never log secrets.
- Required migration target, not completed purity: existing bridges remain
  explicit, temporary exceptions, not permission to add more.

## Protocol and integration invariants

- Public entrypoints are mapped in README. Never accept `verified=true`.
- Org identity is the genesis record hash. `protocolVersion=1` only in genesis.
  Ordinary records omit Org ID, sequence, and generic operation IDs. Wire is
  `@ipld/dag-cbor` fixed arrays; keys, signatures, and hashes are raw bytes.
- `Ledger.verify`/`extend` are pure and immutable: parse, hash, verify all
  signatures (including nested proofs), then replay policy. Never skip invalid
  records or grant unverified authority. The 10k/100ms target is withdrawn, not
  passed; SIMD/Wasm/threads are not required. Verification defaults to sequential;
  Node workers require explicit `createNodeSignatureVerifyExecutor`, no detection.
  Inject entropy/clocks/timers/executors; production uses live secure randomness
  and real time through platform adapters.
- Snapshot join (§6.1, DEC-001): out-of-band genesis, endorser, attested head
  and endorser signature; only a current Owner/Admin personal device may endorse.
  Bind complete state, replay facts, genesis, position and head, not head alone.
  Verify increments; full replay is optional audit. Independent comparison detects
  divergence, not global freshness or honest history. Preserve rollback, CAS,
  freshness, historical-key and recovery guarantees. Refresh may skip prefix until
  observing/extending the attested head; thereafter wrong parents, foreign genesis
  or duplicate known hashes fail closed without cursor advance. Unknown prefix,
  even junk followed by an empty final page, must not become up-to-date success.
- Persist exact pending bytes before CAS. Conflicts never re-sign; retry the
  same bytes. `./effect` has the intent client; old `./ledger` submit/resume
  delegate to the same `workflows/ledger-engine.ts`. No second submit path.
  Guard `pure/ports/workflows` with `check:effect-boundaries --complete`.
  Native verify/extend live in `workflows/verification.ts`; `./ledger` unwraps.
  See the migration note in README.
  Malformed pages must not become Pending.
  `openEpochEnvelope` requires `canSendEpoch` (also exported for gateways), an
  admitted recipient, current epoch and matching `commitEpochKey`. Every active
  personal/machine device, including Guest, may forward; R only receives.
  Sender role is not key-authenticity evidence.
- Device possession uses `possess/v2` and binds the target membership inferred
  from the actor's preceding verified state. Check during replay even with a
  worker verifier. v1 proofs are rejected, not silently migrated or re-signed.
  Devices carry no management flag: management = active personal device ∩
  current Owner/Admin role, so role changes apply to all personal devices at
  once. Old 6-element admitDevice and 5-element snapshot device rows fail.
- Roles owner/admin/member/guest; guest read-only; machines have no Org
  management. Device revoke is this-Org and the named device only. Owner
  transfer is unilateral `[6, successorMembershipId]`; predecessor becomes
  Admin; successor must already be a member.
- Recovery device R receives epoch keys and may admit that user's personal
  devices; those follow the user's current role like any personal device. Passkey/file wrap the same R independently; leaking R
  requires replace-R, update entries, and per-Org revoke-old-R plus rotation.
- Signing keys must be canonical nonzero prime-subgroup Ed25519 points.
  Verification uses pinned noble-ed25519 with `zip215: false` and explicit
  subgroup checks for A and R. Only native signing handles private keys.
- Device storage stays in Electron main. Only opt-in Streams adapters call the
  supplied SDK; no implicit stream creation or anchor choice. Synthetic fixtures,
  real signatures, no crypto stubs.
- `content.ts`: XChaCha20-Poly1305, HKDF-SHA-256, strict Ed25519. Caller policy
  supplies authority; `inspectContent` is UNVERIFIED routing metadata;
  `authenticate` checks signatures without decryption, not publication permission.
  `streams-content.ts` uses existing streams-crdt `seal`/`open` for updates and
  snapshots. Only active personal/machine writers may write; snapshot sealing
  requires `deviceMayWriteDocument`, excluding Guest/R. Bind genesis, resource,
  kind/model, epoch and opaque continuation offset. `./snapshot-admission`
  requires current write permission, submitter/signing-device binding and the
  original 15-minute lease, rechecked after async verification immediately before
  storing exact bytes, never restarted. Exact retries are idempotent; different
  bytes at an admitted offset fail. Open does not recheck current write.
  Decryption, offset, old head or self-declared time cannot prove admission.
  Production JWT/gateway remains unimplemented; keep product E2EE off.
- `snapshot-publication-store.ts`: platform-neutral synchronous atomic port;
  memory default is not durable. Node implementation is exported only through
  `./node-snapshot-publication-store`. Only `{ create: true }` creates SQLite;
  ordinary open never recreates missing/foreign storage. Verify outside the lock;
  inside, re-read identity/current and recheck original lease/device permission
  before atomic ciphertext/identity/pointer commit. Success follows commit.
  Busy retries unchanged input, never erases/steals locks. No cross-stream
  transactions or JWT wiring; synchronous transactions must remain synchronous.
- `streams.ts` uses the pinned SDK read/`appendCas` APIs and length framing.
  Never invent offsets, fall back to ordinary append, or auto-re-sign. HTTP
  reads can split frames; checkpoint only complete frames/pages.
- `./ledger-node` and `node-store.ts` are Node-only; never re-export from the
  root. Application-owned local filesystem; SQLite EXCLUSIVE; corrupt/foreign
  journals fail closed. Experimental journal/outbox formats are not V4.
  `./effect/platform-node` requires explicit create/open; open must never
  initialize missing/foreign storage. Pure journal codecs preserve v0/v1 bytes.
- Legacy JSON/hex (`team.ts`, `KeyDelivery`, `EpochPublisher`, v3 genesis):
  still reject old v1/v2 unchanged; `canManage` is explicit; machines false;
  admit/cancel consume `(identity, requestId)` permanently; expiry is checked
  at trusted atomic admission, never historical replay; never re-sign pending;
  `ControlFreshnessLease` is not a JWT. History-stream publishers are not the
  ledger history-packet path.
- `node-device-store.ts`: never regenerate on load failure; no private-key IPC.
  `node-received-key-store.ts` saves original HPKE ciphertext. Disk presence is
  not authority.
