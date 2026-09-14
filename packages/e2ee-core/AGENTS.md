# E2EE core

Experimental primitives, not enabled product E2EE.
Binding surface: [ledger spec](../../specs/e2ee-ledger.zh.md) and
[README.md](README.md). JSON/hex control-log lives in `src/legacy.ts` for
in-package tests only; do not re-export it.

- Public exports: root `Ledger`/`LedgerError`/`ContentCipher`/recovery-file/
  `createUserIdentity`/`restoreUserIdentity`/`ControlFreshnessLease`; subpaths
  `./ledger`, `./ledger-node`, `./streams`, `./streams-content`. Never pass
  `verified=true`. Snapshot join uses out-of-band genesis, endorser, attested
  head, and the endorser's signature over that head.
- Org identity is the genesis record hash. `protocolVersion=1` only in genesis.
  Ordinary records omit Org ID, sequence, and generic operation IDs. Wire is
  `@ipld/dag-cbor` fixed arrays; keys, signatures, and hashes are raw bytes.
- `Ledger.verify`/`extend` are pure and immutable. Parse, hash, verify every
  signature including nested proofs, then replay policy. Never skip an invalid
  record or grant unverified authority. The 10k/100ms gate is withdrawn, not
  passed; no required SIMD/Wasm/multithreading work for that target.
- Approved direction (§6.1): authenticated signed authorization-state snapshot
  for first join, then fully verified increments; full replay remains optional
  audit. Snapshot signer trust must be established outside that snapshot.
  Bind actual complete state, replay facts, Org/genesis, position and head;
  comparing only the head does not authenticate the imported state. Independent
  comparison detects divergent views, not globally latest or honest history.
  Confirmed DEC-001 (2026-09-14): `verifySnapshot` trust is out-of-band
  genesis + endorser + attested head + endorser signature over that head.
  Only Owner/Admin personal+canManage may endorse. No `verified=true`.
  Preserve rollback/CAS/freshness, historical-key and recovery guarantees.
  Snapshot refresh may skip stream prefix until the attested head is observed
  or a suffix extends it; after that bound, any record that does not extend
  the attested chain (wrong parent, foreign genesis, duplicate known hash)
  fails closed and must not advance the journal cursor. Unknown prefix must
  not become up-to-date success, including junk followed by an empty final page.
- Persist exact pending bytes before CAS. Conflicts never re-sign; retry the
  same bytes. `openEpochEnvelope` returns plaintext only when epoch matches and
  `commitEpochKey` equals the ledger commitment.
- Roles owner/admin/member/guest; guest read-only; machines have no Org
  management. Device revoke is this-Org and the named device only. Owner
  transfer is unilateral `[6, successorMembershipId]`; predecessor becomes
  Admin; successor must already be a member.
- Recovery device R receives epoch keys and may admit that user's personal
  devices. R may set `canManage` only when the user is currently Owner/Admin;
  submit re-checks. Passkey/file wrap the same R independently; leaking R
  requires replace-R, update entries, and per-Org revoke-old-R plus rotation.
- Signing keys must be canonical nonzero prime-subgroup Ed25519 points.
  Verification uses pinned noble-ed25519 with `zip215: false` and explicit
  subgroup checks for A and R. Only native signing handles private keys.
- Device storage stays in Electron main. Inject ports; only opt-in Streams
  adapters call the supplied SDK. Never create streams or choose anchors
  implicitly. Synthetic fixtures only; real signatures; no crypto stubs.
- `content.ts`: fixed XChaCha20-Poly1305, HKDF-SHA-256, strict Ed25519. Caller
  policy supplies authority; `inspectContent` is UNVERIFIED routing metadata.
  `streams-content.ts` seals updates and content snapshots through the existing
  streams-crdt provider `seal`/`open` (no parallel encryptSnapshot API). Snapshot
  writers must have document-write capability (`deviceMayWriteDocument`); guests
  cannot. Bind Org/genesis, resource, kind/model, epoch, and the opaque
  continuation offset. Host-admitted bootstrap offset is the publication
  evidence under the existing 15-minute backend-trust cutoff; a later revoke
  does not invalidate that admitted snapshot. Do not enable production E2EE.
- `streams.ts` uses the pinned SDK read/`appendCas` APIs and length framing.
  Never invent offsets, fall back to ordinary append, or auto-re-sign. HTTP
  reads can split frames; checkpoint only complete frames/pages.
- `./ledger-node` and `node-store.ts` are Node-only; never re-export from the
  root. Application-owned local filesystem; SQLite EXCLUSIVE; corrupt/foreign
  journals fail closed. Experimental journal/outbox formats are not V4.
- Legacy JSON/hex (`team.ts`, `KeyDelivery`, `EpochPublisher`, v3 genesis):
  still reject old v1/v2 unchanged; `canManage` is explicit; machines false;
  admit/cancel consume `(identity, requestId)` permanently; expiry is checked
  at trusted atomic admission, never historical replay; never re-sign pending;
  `ControlFreshnessLease` is not a JWT. History-stream publishers are not the
  ledger history-packet path.
- `node-device-store.ts`: never regenerate on load failure; no private-key IPC.
  `node-received-key-store.ts` saves original HPKE ciphertext. Disk presence is
  not authority.
