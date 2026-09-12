# E2EE control-log core

Experimental primitives, not enabled product E2EE.
Read [README.md](README.md) and the [protocol draft](../../specs/e2ee-control-log.zh.md)
before changing the wire format, verification, persistence, or submission behavior.

- Device storage stays in Electron main. No embedded credentials or policy defaults.
  Core ports are injected; only opt-in Streams adapters call the supplied SDK client.
  Never create streams or choose anchors implicitly. Policy derives signers from
  previous verified state, member/device instances and explicit capabilities.
- Verify canonical bytes, chain continuity, operation uniqueness, policy and every
  required signature before advancing state. Never skip an invalid record.
- Signing public keys must be canonical, nonzero prime-subgroup Ed25519 points,
  including genesis/admission/transfer keys. Verification uses pinned noble-ed25519
  with `zip215: false` and explicit subgroup checks for A and R; never substitute
  permissive native verification. Only native signing handles private keys.
- `team.ts` is an explicit conservative policy profile, never automatically installed.
  The boundary is an encrypted Org; `Team*` names are historical. Genesis/actions use v3;
  reject old v1/v2 actions and old-anchored journals unchanged, never reinterpret them.
  Devices belong directly to a user: any active personal device may revoke only
  the named own device in this Org. No parent/ancestry/identity-root mode remains.
  Roles follow the current user and intersect explicit device `canManage`; Machines
  cannot manage; neither kind nor role grants this capability implicitly. Member removal
  invalidates all devices/recovery in that instance.
  Owner/Admin management devices may rotate; removal/role changes remain Owner-only.
  `member.admit/cancel` bind detached applicant identity/device consent; verify both
  proofs before state/persistence. Consumption is permanent per identity/request ID.
  Expiry is checked at trusted atomic admission, never today's historical replay.
  Creator trust comes from accepted genesis, not hashing alone. Every Org action binds
  the current Owner config and member instance; machine execution scope remains unresolved.
  Removed devices/instances never revive implicitly.
- Transfer requires current and accepting management-device signatures; the former
  Owner becomes Admin. There is no separate management key or backup commitment.
  Revocation sets `requiresKeyRotation`; Owner/Admin `epoch.publish`
  clears a publication obligation, not delivery/activation. It must not gate uploads.
  Epochs start at zero, are consecutive and cannot reuse a commitment in this Org.
- `content.ts` uses fixed XChaCha20-Poly1305, HKDF-SHA-256 and strict Ed25519.
  Never accept a public key claimed by a content header: a mandatory caller policy
  supplies verified authority and epoch eligibility, rechecked after async crypto.
  `inspectContent` returns UNVERIFIED routing metadata only. Scope/purpose must
  match the caller's expected resource; no plaintext or alternate-suite fallback.
  New encryptions generate fresh random nonces/message IDs; retries retain exact
  signed bytes. No transport, CRDT import, cursor save, execution or durable dedup
  occurs here. Snapshot provenance and current-vs-historical admission belong to
  the application, not to a blanket "currently active device" predicate.
- `streams-content.ts` is an opt-in incremental provider for streams-crdt 0.15.1.
  Authenticate exact SDK AAD; encrypted-only reads/writes, fixed write epoch per room.
  Reject snapshots without provenance; batch publisher is not every operation's author.
  This incomplete provider must not enable production E2EE.
- `key-envelope.ts` fixes HPKE Base X25519/HKDF-SHA256/ChaCha20Poly1305 plus
  strict Ed25519; reject KEM aliases/low-order keys. Policy rechecks trusted keys
  before return. `OrgKeyExchange` verifies admission/commitments and refreshes before
  return: send checks current authority; receive checks historical sender and current
  recipient. Enforce its mandatory freshness/session guard; invalidate known revocation.
  Preparation is not transmission, decryption is not durable installation or membership.
- `epoch-keys.ts` verifies an Org-bound SHA-256 key commitment before installing
  a volatile copy. Recheck policy after hashing and on every read; a concurrent
  clear cancels pending installations. `sealEpochHistory` wraps
  only N-1 under N with the distinct `epoch-history` purpose; `importHistory`
  verifies the old commitment before installation and respects concurrent clear.
  Historical sender verification must not require that sender to remain active today.
- An append acknowledgement is not verification or freshness. Reconcile against
  the verified log; never regenerate/re-sign a pending attempt automatically.
  `EpochPublisher` pins intent ID/head and reuses saved wire; it never delivers keys.
- Storage adapters must serialize across instances/processes and atomically persist
  verified records/cursor plus the exact pending wire before network submission.
  Streams supplies a cursor per page, not per record: verify and save the whole page
  together. A bad record cannot save its page's valid prefix or advance its cursor.
  Catch up through `upToDate` before CAS; that flag is not an independent freshness proof.
- `streams.ts` uses the pinned SDK's read/appendCas APIs and explicit length framing.
  Never calculate opaque offsets, fall back to ordinary append, or auto-re-sign retries.
  HTTP reads can split frames; only complete frame/page boundaries may be checkpointed.
  SDK buffers bodies: opt-in `createBoundedStreamsFetch` limits bytes/deadlines before buffering.
  Its request lease must be authenticated; client cancellation never proves server rollback.
- `node-store.ts` is an opt-in Node-only subpath; never re-export it from the
  platform-neutral root. Use an application-owned local filesystem, not NFS or
  a cloud-synced live database. Do not rename/unlink/replace an open database.
  SQLite EXCLUSIVE mode retains the lock across independently committed saves;
  contention fails with `journal-busy`. No lease expiry, busy wait or lock stealing.
  Corrupt/foreign/unknown-version journals must fail, never reset automatically.
  Page journals use format/schema v2; v1 is rejected without migration or deletion.
- Synthetic fixtures only. Exercise real signatures and deterministic races/failures.
  No boolean crypto stubs, timing luck, production keys, or transcript fixtures.
- `ControlFreshnessLease` accepts only authenticated observations and trusted time.
  Preserve absolute expiry on restart; it is not a proof verifier or a JWT issuer.
- `node-epoch-store.ts`: atomically save wrapped candidates, history bridges and outbox, never raw keys.
  Candidate schema v2 rejects v1 unchanged. Epoch N > 0 requires its N-1 bridge;
  the publisher verifies the old commitment before sealing, the uploader re-verifies.
  No ordinary-journal migration or automatic cleanup. Retain reconciled keys; restore
  via verified current policy. No saved commitment reuse for another candidate.
  History outboxes contain ciphertext only; retry re-verifies ledger/key evidence.
  Exact remote read-back is not epoch activation or guaranteed availability.
  `StreamsHistoryRemote` uses a separate stream, full bounded scans and CAS only;
  transport routing is not authentication and must pass HistoryPublisher verification.
- `node-device-store.ts`: explicit create/load; never regenerate on load failure.
  Persist OS-wrapped keys before returning non-extractable handles, check key pairs
  and account binding; no private-key IPC or implicit membership restoration.
- `node-received-key-store.ts` saves original HPKE ciphertext, not raw keys or a backup.
  Reopen through OrgKeyExchange after saving and on every restore; disk presence is not authority.
- `KeyDelivery`: exact ciphertext before dispatch; reauthorize after save and on retry.
  Separate outbox DB/stream. SDK key uploads reauthorize after scanning, before CAS.
  Read-back is not installation; never re-encrypt retries.
