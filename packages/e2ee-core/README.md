# @lody/e2ee-core

**Design review in progress:** the [updated ledger types and API](../../specs/e2ee-ledger.zh.md)
specify the intended single-signer format and pure verification boundary. The implementation
described below is an earlier prototype, not that design's frozen API. Lody integration is paused.

Experimental control-log and signed content-encryption primitives. **Electron main imports the device store only;
it is not end-to-end encryption for Lody.** [Protocol draft](../../specs/e2ee-control-log.zh.md).

**Flat device policy implemented (2026-09-12).** Devices bind directly to users;
any active personal device can revoke only the named own device in this Org.
Roles are read from the current user state. The Org genesis/action domains are now
v3: old v1/v2 actions and journals anchored to old genesis are rejected unchanged, not silently
replayed under the new policy. The outer control wire and page journal formats are
unchanged. Detached joining consent is implemented below; Admin key delivery and
skippable mobile backup remain unwired. Machines cannot manage; transfer makes the former Owner an Admin.

The v3 profile removes separate management keys and backup commitments. Every
device registration explicitly carries `canManage`; it caps control-log operations
and is intersected with the current user role. Machines must use false. Personal
devices with false can receive content but cannot govern or accept ownership.
The initial Owner device must use true; admission never infers or defaults this
field. Machine command execution authorization is a separate unimplemented boundary.

| File                       | Responsibility                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `src/wire.ts`              | Bounded canonical ASCII encoding, Ed25519 signatures, SHA-256 record hashes            |
| `src/chain.ts`             | Replay from a trusted genesis; mandatory application policy and exact required signers |
| `src/client.ts`            | CAS, durable-outbox contract, verified read-back and interrupted-attempt resolution    |
| `src/node-store.ts`        | Opt-in SQLite journal with process-wide locking and separately durable checkpoints     |
| `src/streams.ts`           | Opt-in Streams SDK read/CAS adapter, bounded length framing and opaque page cursors    |
| `src/team-codec.ts`        | Explicit canonical Org action/genesis tuples                                           |
| `src/join-request.ts`      | Independent applicant consent, strict verification and explicit expiry preflight       |
| `src/org-key-exchange.ts`  | Verified historical/current Org authority around key envelope preparation and opening  |
| `src/team.ts`              | Opt-in Owner-managed membership, devices, transfer and recipient selection             |
| `src/content.ts`           | Scoped HKDF, XChaCha20-Poly1305, strict signed binary envelopes and injected authority |
| `test/control-log.test.ts` | Real signatures, synthetic member policy, deterministic stream/storage faults          |
| `test/team.test.ts`        | Real Org policy/signatures, flat devices, roles, transfer, version and instance replay |
| `test/node-store.test.ts`  | Real SQLite files, child-process termination, contention and checkpoint rejection      |
| `test/streams.test.ts`     | Actual SDK with a deterministic HTTP peer, split frames, CAS and page recovery         |
| `test/content.test.ts`     | Known cipher vector, independent HKDF, malformed envelopes and real Loro/Flock bytes   |

Use `replayChain(anchor, wires, policy)` for verification. `WebCryptoControl.sign`
accepts non-extractable Web Crypto signing keys. `ControlLogClient` additionally
requires a `ControlStore` and `ControlStream`; it provides `read`, `submit(wire)`
and `resume`. A conflict never silently reconstructs or signs an operation.
`readOperation(operationId)` returns exact verified historical wire (or `null`)
alongside the fully refreshed snapshot. It never submits or clears pending, but
does persist verified checkpoints. It fails on incomplete/invalid catch-up rather
than returning early when the requested record is found. Absence is relative to
the backend-observed prefix; historical inclusion is not current authorization.
`readAtHead(head)` similarly returns an independently replayed historical snapshot
alongside the fully refreshed snapshot (or `atHead: null` if absent). It cannot return
early through a later bad page or refresh failure; it never submits or clears pending.
It currently replays the historical prefix again instead of storing trusted state caches.

The policy is trusted code, not optional configuration: its synchronous
`transition(previousState, event)` validates the whole action and returns a proposed
next state plus the exact required public keys and optional detached signature proofs.
Proof bodies must be bound to the action by the policy; they never replace the actor signature.
State must support structured clone.
Only after **all** signatures pass is that state accepted. Unknown actions must throw.
The core cannot detect a policy that mistakenly authorizes everyone.

### Asynchronous joining consent (not yet a product invitation flow)

`signJoinRequest` signs an immutable application with both the applicant's identity
and first personal device. It binds the accepted Org genesis, a caller-retained random
request ID, a named approver's user/member instance, the applicant's complete public
identity/device and explicit `expiresAt`. No default lifetime is chosen (`null` explicitly
means no automatic expiry). `verifyJoinRequest` checks both strict signatures and the
expected Org; it does not certify the claimed account or grant membership.

The approver then signs `member.admit` against the latest verified chain head. Only
the named, currently authorized Owner/Admin management device can approve; ordinary
head changes do not require fresh applicant consent. `member.cancel` requires that
applicant device's outer signature and the original consent, even before membership.
The first successful CAS consumes `(identity signing key, request ID)` permanently;
neither cancellation after admission nor replay after removal revives membership.
The old full-record `member.add` action remains strict and unchanged.

`assertJoinRequestFresh(request, now)` is an explicit preflight/admission helper.
Production must check time again at the trusted **atomic** admission boundary, not
just on a client or before a network wait. Expiry prevents a new approval; it does
not expire membership on historical replay. That production gate, encrypted request
delivery, account/key confirmation UI and post-admission key delivery are not wired.
The request returned here is signed **plaintext**, not an encrypted invitation.

### Org-authorized key envelopes

`OrgKeyExchange` composes `ControlLogClient`, the explicit v3 Org policy and existing
HPKE/Ed25519 cipher. The constructor requires a trusted anchor, store, stream and
application-owned freshness/session guard; a successful stream read alone is not a lease.
The guard receives a copy, cannot mutate authorization state, and must reject a stale
or closed session. `invalidate()` cancels in-flight work on known revocation/logout.

`ControlFreshnessLease` supplies a local guard for an **already authenticated** control
observation: explicit Org genesis, exact head/length, original `observedAt` and absolute
`expiresAt` in Unix milliseconds. Pass `snapshot => lease.assert(snapshot)` to the exchange.
The observation window cannot exceed 15 minutes; the application must shorten it for
its remaining clock/delivery/enforcement budget. Receipt, calls and reconstruction do
not reset expiry. Exactly at expiry it rejects; logout, expiry, unavailable clock or
observed clock rollback permanently invalidate that instance. Input is copied, and an
observation never covers an unproven later checkpoint.

This is not a signed proof format, device authenticator, anti-rollback storage or JWT
issuer. Authenticate observations and supply trusted time before use; a plain backend
read or local wall clock cannot establish that trust. Restart requires trusted current
time and reauthentication of the original observation, not replacing its timestamps.
Production observation issuance, transport cancellation and runtime wiring remain pending.

`prepare` refreshes the ledger, checks current sender/recipient eligibility and the
latest published key commitment, then seals and refreshes again before returning.
Owner/Admin management devices may send to active recipients; Members may copy only
to their own already-admitted devices/recovery identity. Machines cannot distribute.
Pending rotation does not block the current usable epoch; a newly published epoch
prevents preparing another envelope for the old one.

`open` verifies that the envelope's control head belongs to the complete verified
prefix, the sender was authorized there, and the recipient is still eligible now.
It checks the decrypted key against the ledger commitment and refreshes again before
returning it. Unrelated head changes, later sender demotion and newer epochs do not
invalidate historical delivery to a retained recipient. Recipient revocation or a
missing historical head rejects it; a valid Admin signature cannot substitute a wrong key.

These methods do not themselves upload ciphertext or persist/activate the received key. Their
outputs are a prepared envelope or temporary verified secret (caller must erase after
use). Network dispatch must still reauthorize at dispatch/retry, and received keys must
be safely persisted before reporting completion. Production freshness guards, recipient
receipt handling and runtime installation remain unwired. Node reception can
now persist the original HPKE envelope using `SqliteReceivedKeyStore` below.

`KeyDelivery.send(id, frame?)` adds durable sending. Retain a random 16-byte delivery
ID; omit the frame on restart to retry the exact ciphertext from `SqliteKeyDeliveryStore`.
Its database must be separate from the control log. The driver authenticates the stored
signature/historical admission and current sender/recipient/latest epoch, persists,
then reauthorizes before dispatch. It never re-encrypts retries. Revocation or a newer
epoch rejects retry; the application explicitly prepares a new delivery if appropriate.
The sender cannot check HPKE plaintext without the recipient key; preparation and
recipient installation must still verify the epoch commitment.

The injected Org-bound remote provides idempotent exact-byte `put/read`. Write errors
may be lost responses; only identical read-back yields `observed`, otherwise `unknown`
or mismatch error. Neither result proves recipient decryption/installation. The remote
must enforce credentials/freshness at actual dispatch, including its internal waits;
the synchronous local guard is not a server token. Production composition remains unwired.

`StreamsKeyDeliveryRemote` from `./streams` now implements this remote using the
pinned SDK. It reuses the history transport's opaque ciphertext framing and bounded
CAS scan, but requires a **separate precreated key-delivery stream** and `OrgKeyExchange`.
It reauthorizes after scanning, immediately before invoking CAS; no ordinary append or
SDK retry fallback. Read-back is still unverified ciphertext for the receiving verifier.
The shared framing limit is 4234 bytes, with the key adapter enforcing its stricter
2194-byte envelope limit. Credentials, pre-buffer response limits/deadlines, and actual
production control admission still belong to the application, not this adapter.

The opt-in `./node-key-outbox` database uses application ID `0x4c4b4431`, schema 1,
canonical `["lody-key-outbox/v1", genesis, [[deliveryId, frameHex], ...]]`, sorted by ID.
At most 4096 entries/16 MiB; same ID with different ciphertext, unknown/foreign formats
or corruption reject without replacement/reset. Entries contain ciphertext only.

`deriveTeamAnchor(acceptedGenesis)` and `ownerManagedTeamPolicy` now provide an
explicit conservative Org profile; neither is installed by default. Version one's
product boundary is an encrypted Org, with no Team layer. The existing `team*`/
`Team*` symbols and the `lody-team-*` prefix are historical prototype names;
they do not introduce another permission boundary. Use the
derived anchor, not a server-provided permission snapshot. The profile supports
member admission/removal/roles, direct own-device admission, target-only device
revocation and jointly signed Owner transfer. Device admission needs the current
personal device and new-device possession signatures, not an identity-root mode.
Removing a user still removes all devices and recovery eligibility for that instance.
Already admitted devices survive their approver's revocation, including any malicious
device admitted before compromise was contained; each must be explicitly revoked. Initial
members must have a personal device; Machine devices never authorize control changes.
Every operation binds the current Owner config and membership instance. The generic
driver fixtures remain intentionally small; the Org suite tests the actual policy.

The legacy `member.add` and device/Owner multi-signature operations require participants
to sign the same full record. Product member invitations must use the implemented
detached application and `member.admit` wrapper, not the legacy synchronous path;
unrelated head changes do not require renewed applicant signatures. Encrypted request
hosting and atomic production expiry/admission checks remain unwired. Current
keys are released only after verified admission; the target permits the approving
Admin to send them directly, without waiting for Owner key distribution. Removed backup hashes
were attestations, not verification of backup storage; v3 requires no backup commitment. All-devices-lost and
root-key recovery/rotation are deliberately unsupported. `listTeamRecipients` is
eligibility only; it must not trigger key release without verified current policy
and the epoch protocol. Revocation sets `requiresKeyRotation`; Owner/Admin publication
clears a publication obligation, not delivery or activation; it must not block uploads.

The store must implement atomic durable replacement and exclusive access across all
clients/processes sharing the journal. The optional Node adapter below implements
this storage contract; the opt-in Streams adapter supplies SDK read/CAS. Stream offsets are opaque; a complete read is still
only as fresh and non-forking as the backend. A verified `committed` result is historical
evidence, **not** permission to release secrets against an older membership state.

This prototype stores the entire verified control prefix and replays it per call.
It deliberately has no persisted authority cache, background retry timer, implicit policy defaults,
implicit trust bootstrap, or production wiring.

## Content encryption

### Recovery-file wrapping (not a recovery workflow)

`createRecoveryFile` generates a random 32-byte wrapping key and 16-byte backup ID.
`parseRecoveryFile` strictly accepts only the bounded canonical file; it never reads a URL.
`sealRecoveryBackup` / `openRecoveryBackup` use XChaCha20-Poly1305 with fresh 24-byte
nonces and bind the expected user-identity fingerprint, material revision and backup ID.
Material is 1–2048 opaque bytes: the identity owner must serialize user secrets, not
device keys/tokens, and validate restored key pairs before installation. These functions
do not infer current identity from the downloaded header or prevent rollback when the
caller supplies an old expected revision. Clear returned secret buffers after use;
JavaScript string/runtime copies cannot be guaranteed erased.

File plus matching ciphertext suffices offline; login is not a second cryptographic
factor. No network, persistence, membership grant, backup-ready flag or automatic
identity replacement occurs. Saving/reselecting a file, verifying the actual uploaded
backup, Passkey support, user-identity storage and device recovery remain unwired.
Four tests cover direct-library interoperability, wrong contexts/keys, tampering,
noncanonical files, truncated/oversized frames and nonzero-offset byte views.

`createUserIdentity` generates independent user signing/encryption keys and returns
explicit secret `privateMaterial` plus non-extractable handles. Persist that material
securely before publishing the identity; creation is not durable or a backup-ready signal.
`restoreUserIdentity(material, expectedFingerprint)` validates canonical user-only
format, the public fingerprint, Ed25519 possession and X25519 pair agreement before
returning handles. Device bundles and mismatched private/public pairs reject. The
identity is independent of device IDs, account sessions and Org membership; no automatic
replacement, registration or authorization occurs. Temporary PKCS8/DH buffers are wiped;
native/JS string copies and initially exportable generation handles are not guaranteed erased.
Three additional tests restore real signatures/DH through the recovery-file cipher,
reject authenticated-but-mismatched key material, and capture input before async crypto.

`ContentCipher` provides `seal({ scope, author, epochKey, signingKey, plaintext })`
and `open(scope, epochKey, frame)`. The caller supplies a mandatory
`ContentPolicy.authorize(header)` that returns a verified signing key or throws.
It must select the appropriate current/historical authorization and epoch eligibility;
this package never trusts a header's identity claims or installs an active-member default.
The policy is checked again after asynchronous crypto before releasing an envelope or
plaintext. The caller still owns authorization between return, CRDT import and persistence.

Scope binds Org genesis, epoch, logical resource ID and purpose. Purposes distinguish
Loro/Flock updates and snapshots, blobs, presence, RPC requests and responses. Keys are
derived with native HKDF-SHA-256; payloads use pinned
[@noble/ciphers 2.1.1 XChaCha20-Poly1305](https://github.com/paulmillr/noble-ciphers/tree/2.1.1),
with a fresh random 24-byte nonce and 16-byte message ID for every encryption. No caller-supplied
nonce is accepted. Retry an existing transmission with the original signed bytes.
The complete header is authenticated as AAD; strict Ed25519 covers the header, nonce,
ciphertext and tag. Native signing can retain a non-extractable device private key.

`inspectContent(frame)` only exposes **unverified** metadata to locate a known epoch key.
Successful inspection, decryption or signature verification alone does not authorize a
machine command, prove freshness or deduplicate an operation. Replay tracking, snapshot
source evidence, application runtime wiring, key distribution and production
admission are still pending. Tests relay genuine Loro updates and Loro/Flock snapshots;
they do not establish original authorship of every operation inside a merged snapshot.

The experimental frame accepts at most 16 MiB of plaintext and a 4096-byte canonical
header, with no plaintext/version fallback. This is an in-memory primitive, not large-file
chunking or a whole-application attachment size guarantee. It copies mutable inputs before
awaiting and clears temporary raw key/plaintext buffers on completion; JavaScript/Web Crypto
do not guarantee erasure of all runtime copies. See the protocol draft for exact framing.

## Epoch key envelopes

`KeyEnvelopeCipher.seal(context, epochKey, signingKey)` and
`open(expectedContext, recipientKeyPair, frame)` protect a single 32-byte epoch key
with HPKE Base X25519/HKDF-SHA-256/ChaCha20-Poly1305 and an outer strict Ed25519
signature. The fixed implementations are `@hpke/core@1.9.0` and
`@hpke/chacha20poly1305@1.8.0` (locked common dependency 1.10.1).
No handwritten KEM or suite negotiation is introduced. Native non-extractable
X25519 private keys work when supplied with their public key.

Context binds Org genesis, epoch, control-head evidence, sending device/member
instance and receiving device/recovery identity. A mandatory policy supplies verified
public keys and checks send/receive authority before and after asynchronous crypto.
Metadata is visible, but authenticated both by HPKE AAD and the outer signature.
Noncanonical recipient-key aliases are rejected; the native KEM rejects low-order
keys during encapsulation. New seals use fresh encapsulation; network retries retain
the original bytes. The caller must not publish envelopes before verified admission.

This is **not** an admission/recovery/epoch service. The policy still needs actual
ledger/freshness wiring. `VerifiedEpochKeys` checks the delivered key against a
verified Owner/Admin publication commitment before volatile installation. Successful decryption does not
restore revoked membership or authorize execution. The caller selects the raw input
key; this module cannot distinguish a mistakenly supplied private key from an epoch
key. Temporary explicit plaintext copies are cleared; runtime copies are not guaranteed
erased. Tests cover the public CFRG HPKE vector, direct-library interoperability,
tampering, wrong recipients, mutable inputs and revocation while awaiting crypto.

## Owner/Admin publication and volatile epoch keys

The experimental Org policy accepts `epoch.publish` from a current Owner's or Admin's
active personal device with explicit canManage permission; no separate management signature. It binds
the current Owner configuration and chain head. Epochs start at zero and increase
by one; `TeamState.epochs` retains their commitments. Old-head races use ordinary
CAS rejection; a conflicting candidate must not be automatically re-signed or reused.
The new action extends the experimental v3 domain; older readers reject its unknown
kind. Old v1/v2 actions and journals are rejected unchanged, never reset or reinterpreted.

`commitEpochKey(genesis, secret)` computes SHA-256 over the UTF-8 domain
`lody-epoch-secret/v1\0`, the 32-byte genesis, and the 32-byte secret. Omitting the
epoch from this digest lets the ledger reject repeated commitments in the same Org.
The publisher must generate independent random secrets; a public commitment cannot
prove how they were generated or that the Owner retained them safely.

`EpochPublisher(anchor, protectedStore, stream, previousKeys?)` connects this Owner profile
to key generation, signing, protected persistence and the existing CAS driver.
`publish({ operationId, previous }, author)` requires a caller-retained random
operation ID and expected head. It generates a fresh 32-byte secret only for a new
intent; retries locate the exact saved candidate, including after an unsupported
CAS response. Changed head/author cannot reuse an old intent. New intents with a
pending attempt fail; stale heads never trigger automatic re-signing or rotation.
`resume()` submits the pinned pending bytes without generating keys or requiring
signing handles. All attempts still pass the normal driver verification/read-back.
For N > 0, verified previous keys are required: the publisher checks N-1 against
the ledger, seals the history bridge, and saves it atomically with the wrapped new
key and pending wire before CAS. Epoch zero carries no bridge. Retry uses saved
material and does not require the old key or signing handle again.

The result contains status, signed wire, epoch and a verified snapshot, **not key
material or permission to distribute it**. Temporary owned secret buffers are
cleared before submission. Use current verified policy when restoring a saved key.
This is the publication driver, not the full rotation controller: the separate
history outbox below is not wired into rotation; delivery, transport activation,
real OS recovery and product wiring remain unimplemented. There is no separate management key; the old experimental
profile has been replaced with current user-role and explicit device-capability checks.

`VerifiedEpochKeys(genesis, policy)` provides `install`, `read` and `clear`. The
mandatory policy returns the verified commitment and rejects ineligible recipients.
Installation copies input, checks the hash, rechecks authority and only then stores
a private memory copy. Reads recheck policy and return copies. Clear wipes owned
buffers and invalidates pending installations. A wrong delivery cannot replace an
installed key. This is not persistent storage, backup, or a
durable rotation transaction. CAS candidate secrets must still be persisted before
publication, and every required transport must drain/switch before claiming activation.

`sealEpochHistory(cipher, input)` prepares the previous 32-byte epoch key encrypted
under epoch N. It uses the existing signed content frame, fixed resource
`previous-epoch-key` and distinct purpose `epoch-history`; only N > 0 is valid.
`keys.importHistory(cipher, N, frame)` requires verified key N, authenticates the
frame, checks the recovered key against the ledger commitment for N-1 and installs
it. It does not accept arbitrary edges or fetch links recursively. Missing links
remain errors; readers cannot skip an epoch and still claim complete history.
The supplied content policy must verify historical senders against suitable evidence,
not simply reject them because a device was later revoked or Owner transferred.

Bridge inputs are bounded to 4234 bytes and decrypted keys to exactly 32 bytes.
Clear cancels an in-flight history import, and errors do not install the target key.
Tests reconstruct a genuine three-epoch Loro document using only the newest key,
and reject wrong-direction, swapped, corrupted and wrong-key links. The protected
candidate store exists; production bridge transport/availability and restore UI remain unimplemented.

### History ciphertext publication

`HistoryPublisher(log, keys, cipher, store, remote).publish(operationId, frame?)`
requires an already observed `epoch.publish` for N > 0. It verifies the signed bridge,
new key and recovered N-1 key against ledger commitments, then durably saves the
exact ciphertext before upload. Omit `frame` on restart; a newly sealed replacement
for the same publication is rejected. Retry re-verifies evidence and local key eligibility.
The mandatory cipher policy must authorize historical senders from verified evidence.

`observed` means an exact remote read-back, not an ACK, durable availability promise,
current membership grant or permission to activate an epoch. Missing/read-failed
read-back yields `unknown`; different bytes fail. All outcomes retain the saved frame.
The remote port must be bound to the Org and idempotently store exact bytes by operation ID.
`StreamsHistoryRemote` below implements the SDK port; no deployed/runtime adapter
or automatic retry timer is installed.

`SqliteHistoryPublicationStore` (`./node-history-store`) persists only ciphertext and
signed publication wire, with the existing local SQLite durability/locking mechanics.
It uses a separate application ID `0x4c484231`, schema 1, tuple
`["lody-history-outbox/v1", genesis, [[publicationWire, frameHex], ...]]`, at most
4096 entries and 16 MiB. Foreign formats are rejected, never migrated or cleared.
The candidate journal now prepares the bridge atomically with its epoch candidate.
After verified commit, read its ciphertext with `store.readHistory(publicationWire)`
and submit it through `HistoryPublisher`; that read alone proves no authority.
The rotation controller must still gate activation on bridge availability/delivery,
and safely retain previously received keys across Owner transfer/restart.

`StreamsHistoryRemote` from `./streams` uses a caller-bound, precreated binary
history stream, separate from control and CRDT streams. Each record is
`u32be(16 + ciphertext.length) || operationId16 || ciphertext`; this routing wrapper
is not authentication. HistoryPublisher verifies the enclosed signed content frame
and its ledger/key commitments. The transport reads complete history to the tail
before CAS, joining HTTP-split frames and preserving opaque offsets. Identical retries
do not append again; conflicting duplicates, truncated/gone history, invalid types,
nonprogressing cursors and oversized input fail. There is no ordinary-append fallback.

Each scan is bounded to 16 MiB, 4096 records/pages, each ciphertext to 4234 bytes.
This intentionally simple full scan is not an unlimited retention solution. SDK
0.7.0 buffers HTTP bodies, so production composition must enforce body/deadline
limits before buffering, precreate the stream, supply scoped credentials, and
validate write admission. No snapshot/410 recovery or skip-bad-record repair is
implemented. SDK tests use a deterministic HTTP peer, not a deployed backend.

## Incremental Streams provider

`createStreamsContentProvider` from `@lody/e2ee-core/streams-content` implements the
locked streams-crdt 0.15.1 `PayloadProtectionProvider`. Pass it to the SDK's `e2ee`
option with `readPolicy: 'encrypted-only'` and `writePolicy: 'encrypt'`. It captures
one logical resource, CRDT model, author and write epoch; historical keys come from
a caller-owned local lookup. Drain and replace the room session for an epoch change.
No Org, bucket or server URL is added to the synchronization library's abstraction.

The opaque provider header is one byte (`1`). The complete content frame is the
sealed body. Inside its authenticated ciphertext is `u16be(aad.length) || aad ||
originalPayload`, binding the exact SDK-supplied AAD (bounded to 1024 bytes).
The provider invokes the SDK's AAD builder once, checks the binding before returning
plaintext, and declares its outgoing overhead within the SDK's 4096-byte cap.
Existing content framing is unchanged; no alternate crypto suite.

**Snapshots are explicitly rejected on reads and writes**, until source evidence is
implemented. Do not enable this in a production room requiring snapshot bootstrap
or 410 recovery. Even an update batch's signer is its publisher, not proof of every
embedded operation's original author; command dispatch needs its own signed request.
Real SDK write-only/catchup tests check decryption before import, state persistence
before cursor save, and replay after persistence failure. They do not connect a
deployed backend or Lody runtime. See `src/streams-content.ts` and
`test/streams-content.test.ts` for this opt-in boundary.

## Node persistence

### User identity (separate from device identity)

`SqliteUserIdentityStore` from `./node-user-store` supports explicit `create`, `load`,
`sealBackup` and recovery into an empty store only. It OS-wraps and verifies the
roundtrip before atomically saving. Missing/locked/corrupt identities never regenerate;
existing identities cannot be overwritten by create/recover. Account binding and current
session checks belong to the trusted main-process caller; a saved identity is not Org authority.

The user database has application ID `0x4c554931`, schema 1, canonical row
`["lody-user-identity-store/v1", accountBinding32, fingerprint32, wrappedHex]`.
Wrapped bytes are bounded to 8192; it cannot open a device database. Electron's explicit
`createElectronUserProtection` uses the separate `lody-local-user/v1` wrapping domain
with the same OS-availability/plaintext-mode guard as device storage. Electron's
`E2eeUserService` exposes explicit create/load through sender-checked Auth IPC;
it binds the account and auth origin in main, checks the session after queueing and
before returning only public keys/fingerprint. It does not auto-create on login.
`sealBackup` returns encrypted bytes only. Electron Auth IPC can export through a native
save dialog and reselect a recovery file to verify ciphertext against the current local
identity. No raw file secrets or decrypted identity material cross IPC. Cloud upload/read-back,
recovery permission and settings UI activation remain unwired. Real SQLite tests use a synthetic AES-backed
OS port. A real Electron Vite build is executed in both host Node and Electron's Node
runtime, covering create/reopen and locked-store rejection without replacement. This
does not prove real keychain behavior or the installed application's recovery UI.

### Received content keys

`SqliteReceivedKeyStore` from `./node-received-key-store` saves the original HPKE
envelope, not the decrypted secret. The target device's private key must already
be durably protected by the device identity store; no second local wrapping format
is necessary. `receive(context, frame, keyPair, exchange)` authenticates with
`OrgKeyExchange`, saves the ciphertext atomically, then authenticates the saved entry
again. It reports no success if either verification or the disk write fails.
A final refresh failure can leave ciphertext saved for retry, not an installed key.

`restore(epoch, keyPair, exchange)` reopens the saved envelope through current ledger
verification every time, returning a temporary secret for the caller to install/erase.
Wrong identity, revoked recipient, corrupt envelope or unavailable authority fails;
disk presence never grants membership. This is a local ciphertext cache, not backup
against losing all device/recovery private keys. It does not itself attach to Electron,
provide offline restore without the current freshness policy, or activate runtime keys.

The separate SQLite database uses application ID `0x4c524b31`, schema 1 and canonical
`["lody-received-keys/v1", genesis, recipientJson, [frameHex, ...]]`, sorted by epoch.
Recipient fields are normalized as kind/actor/memberInstance/id. At most 4096 envelopes
and 16 MiB per encoded store are accepted. The first authenticated envelope for an
epoch is retained; an equivalent re-encryption does not replace it. Unknown/foreign
databases and corrupt existing entries fail without reset, migration or deletion.
The envelope inspector only supplies unverified routing metadata; authentication
always runs before successful receipt/restoration.

### Device identity

`SqliteDeviceIdentityStore` from `./node-device-store` exposes explicit `create()`
and `load()`; it never regenerates an identity when loading fails. Creation generates
independent native Ed25519/X25519 pairs and a random device ID, OS-wraps the bundle,
verifies the wrapping roundtrip, and persists before returning non-extractable private
CryptoKey handles. Loading verifies both public/private pairs. The required stable
account/domain binding is chosen by the trusted composition; it is not authorization.

`createElectronDeviceProtection` reuses the epoch wrapper's OS-safety guard. It
binds ciphertext to a separate device domain and rejects plaintext-auth mode,
unavailable/unknown storage, wrong account context and malformed bundles. No raw
private material crosses IPC. The node store uses a separate SQLite application ID
`0x4c444931`, schema 1 and bounded `lody-device-identity/v1` ciphertext row; no migration,
automatic overwrite, cloud backup or membership restoration. Other store formats fail.

Private keys are temporarily exportable during creation for OS-protected persistence;
returned handles are not extractable. This is not a hardware-key guarantee or protection
from a compromised local process; JS strings/native crypto copies cannot be guaranteed
erased. Electron's guarded Auth IPC exposes explicit create/load operations returning only
device ID and public keys. Main resolves the account and rejects results after a session
generation change; account/domain storage is isolated. Local-only composition rejects
before resolving cloud authentication. Cached login selects local storage, not Org authority.
Onboarding UI and cross-device recovery remain unwired/unverified.
Cloud Electron now mounts a nonblocking identity initializer when the session user ID
becomes available. Its main-owned `initializeDeviceIdentity` loads an existing identity
and creates only on an explicit missing-record result; other failures never trigger
replacement. It does not register membership, mark backup ready, or gate ordinary
navigation. Encrypted actions must obtain identity independently. Background failure
shows a dismissible bilingual notice with retry; pending retries disable the action,
success hides the notice, and account changes remount the account-scoped UI.
Closing it does not mark identity, membership or backup ready. Four real React/DOM
tests in Electron's standard test command cover retry/disabled/success, dismissal,
stale account completion, and live Chinese/English language changes without duplicate initialization. Session/IPC are synthetic ports; the button and view
are real. Types pass; browser visual and real login IPC acceptance remain pending.
The main service serializes identity operations per account so concurrent windows
share one identity without self-inflicted SQLite contention. Waiting operations
recheck their session lease before accessing storage; failures release the queue.
Separate processes still rely on SQLite locking and can report `journal-busy`.
Synthetic OS-provider tests exercise real signature/DH, SQLite and account switching.

Electron main bundles this source-only package via `externalizeDeps.exclude`; do not
leave its TypeScript exports as installed runtime imports. The Electron test builds the
device service with the real main configuration and checks the emitted module graph.
This isolated build does not verify the full application or the private cloud composition.
The OSS main entry also builds after generating the ACP Core dependency. A separate
Electron 39.5.1 / Node 22.22.0 probe ran the bundled device service against temporary
SQLite, creating and reopening an identity with synthetic AES wrapping. This verifies
runtime compatibility, not OS keychain, renderer, installer or cloud integration.

A subsequent macOS probe used the actual `createElectronDeviceProtection` and
Electron `safeStorage`, with an isolated userData directory and no plaintext switch:
one process created/persisted the identity, then a separate process restored the same
public descriptor. Both exited successfully (Electron 39.5.1). This is a local
development-runtime check only; signed-app identity, locked keychain, Windows/Linux,
login IPC and cross-device recovery remain separate acceptance gates.

Desktop preparation lives in `apps/electron/src/main/services/e2ee-key-protection*`:
an opt-in main-process wrapper binds a local epoch key to genesis/epoch/commitment
and refuses unsafe OS storage. Main wires device protection; epoch protection remains opt-in.
The opt-in candidate store below uses this contract; do not store plaintext keys in
the control journal or mistake OS wrapping for backup or current authorization.

### Protected publication journal

`SqliteEpochControlStore` from `@lody/e2ee-core/node-epoch-store` stores a control
journal and its OS-wrapped epoch candidates in one atomic SQLite row. Supply a
trusted `LocalEpochProtection` (the desktop wrapper implements it), then use
`await store.withCandidate(wire, secret)` as the `ControlLogClient` store for that
exact publication (supply its bridge as the third argument for N > 0). This only prepares ciphertext in memory; the driver's verified
pending checkpoint persists it before CAS. Missing/unreadable/mismatched candidates
prevent submission. `resume` uses the base store and exact saved bytes.

Successful reconciliation clears pending, not the key. `restore(wire, verifiedKeys)`
installs through `VerifiedEpochKeys`' current policy; a saved candidate is not an
verified epoch publication or membership grant. The same stored commitment cannot be used
by another candidate. Uncertain and conflicting candidates are retained, without
automatic deletion or re-signing. Already observed exact publications also retain
the supplied key. Trust still requires normal control replay, current policy and
OS protection; this is not an anti-rollback vault or key-distribution controller.
`findCandidate(operationId)` returns unverified saved wire for exact retry; the
driver must verify it. Duplicate candidate operation IDs are rejected on save/load,
in addition to duplicate commitments; no encoding change or automatic repair.

The separate `lody-epoch-journal/v2` format uses application ID `0x4c454b31`, schema 2,
with `[format, encodedControlJournalV2, [[wire, wrappedHex, historyHexOrNull], ...]]`.
Epoch zero requires null; later epochs require a bounded matching history frame.
Storage checks routing, not bridge authenticity; the publisher seals verified keys
and the history uploader verifies again. Earlier candidate v1 databases are rejected
unchanged, without migration/reset. It cannot open
ordinary v2 journal databases and vice versa; neither migrates/deletes the other.
The whole row is limited to 16 MiB, 4096 candidates, each wrapped blob 1–4096 bytes.
Both stores share `node-text-store.ts`'s existing SQLite lock/durability mechanics;
the ordinary v2 format and behavior are unchanged. No running product uses either
candidate publication wiring or recovery UI yet, and real OS/power-loss validation
remains outstanding.

```ts
import { SqliteControlStore } from '@lody/e2ee-core/node-store';

const store = new SqliteControlStore('/absolute/private-app-data/org-control.sqlite');
// Pass store to ControlLogClient; no separate close() is necessary.
```

This subpath requires Node >=22.13 with `node:sqlite` (experimental on Node 22).
The platform-neutral entry never imports Node modules. The parent directory must
already exist on an application-owned local filesystem; network filesystems and
live cloud-synced databases are unsupported. New files use mode 0600. File symlinks,
hard links, relative paths and `:memory:` are rejected. Do not replace, rename or
delete an active database; backup only after all users have released it. There is
no at-rest encryption and no private-key storage here.

Each `exclusive` opens a SQLite connection, acquires an EXCLUSIVE file lock,
and retains it until the callback ends. Each `save` is independently committed
with synchronous=EXTRA (and fullfsync on supported platforms). A later callback
failure cannot undo a saved pending request. Connection close/process termination
releases the lock. Competing calls reject immediately with `journal-busy`; callers
decide when to retry. This intentionally holds the lock during network waits and
uses synchronous disk IO: run outside a UI thread. Escaped transaction handles expire.

The v2 journal stores complete pages of original signed records, page cursors and pending bytes,
not trusted permissions. `ControlLogClient` always replays and verifies loaded records;
`SqliteControlStore.load` checks encoding only. Unknown schemas/formats
and corrupt data fail without automatic deletion. Earlier experimental v1 journals
are rejected unchanged: there is no implicit migration, reset or data deletion.
This prototype caps the encoded
journal at 16 MiB and individual cursor strings at 1024 characters; exceeding a
limit fails without replacing the previous checkpoint. Compaction is not implemented.
Tests exercise real subprocess termination, not power loss or filesystem faults.

## Streams SDK adapter

```ts
import { StreamsControlStream } from '@lody/e2ee-core/streams';

// sdk is a caller-configured @loro-dev/streams-client@0.7.0 StreamsClient.
const stream = new StreamsControlStream(sdk);
// Pass stream and store to ControlLogClient with an independently accepted Org anchor.
```

The caller owns stream creation, URL, credentials and production admission checks.
For these one-shot control/history/key clients, the same `./streams` entry exports
`createBoundedStreamsFetch`. Supply the native fetch, explicit response-byte and request-time
limits, trusted clock, and a synchronous `authorize(request)` returning a fixed deadline,
revocation signal and validity guard for that exact request/credential. Install the returned
function as `StreamsClient`'s `fetch`. It runs after SDK credential lookup, checks before
dispatch/after headers/around each body read, and limits bytes before SDK `arrayBuffer()`.
Both missing and dishonest Content-Length are covered by counting actual chunks.

The absolute deadline covers headers and the entire body, including an idle stream.
Caller cancellation and known revocation abort the request and error the response rather
than returning a truncated successful body. Redirects are manual and rejected. The caller
must cancel unused bodies; the fixed deadline also bounds abandoned responses. No retry,
refresh, URL selection or access proof issuance is added. Use a native fetch honoring abort
and manual redirects; a custom fetch that already buffers the entire body defeats the
pre-buffer memory boundary. The fetch/runtime may allocate one incoming chunk before this
guard sees it. The configured byte cap is at most 16 MiB and request timeout at most 15 minutes;
choose shorter limits within the authorization budget. This is not a large-attachment/SSE
product transport or **server-side** cutoff, and cancellation does not undo a committed CAS.
Tests through the real SDK preserve pending bytes when a committed write's response expires,
then reconcile the exact original record in a newly authorized session without reappending.

Each CAS writes one `application/octet-stream` frame: a four-byte big-endian length
followed by the exact canonical signed wire. Reads split at arbitrary HTTP page
boundaries are joined through a complete frame boundary; server cursors are never
calculated or copied onto individual records. No ordinary-append fallback is used.
The SDK is called without a producer, so uncertain writes are not retried by the SDK;
the durable outbox and verified read-back determine their outcome. Generic SDK errors,
including a 501 response, do not prove that an earlier write cannot still commit.

`ControlReadPage` contains `records`, `nextOffset` and `upToDate`; `StoredPage`
contains only the records and cursor. All records in a page must pass verification
before that page and cursor are atomically saved, with pending bytes preserved.
A later failure retains earlier complete pages, never the failing page's valid prefix.
The driver finishes catch-up through `upToDate` before returning a snapshot or submitting
CAS. An initial empty read may normalize the reserved `-1` cursor to the empty tail;
later empty reads cannot advance a saved cursor.

Reads are bounded by 4096 records, 16 MiB and 4096 page iterations per catch-up;
the adapter also bounds each grouped read, including frame headers. Exceeding a limit
fails, never reports a truncated result as current. SDK 0.7.0 buffers each HTTP body
**before** these checks: production transport must separately cap response bodies
and deadlines. Tests use the real SDK with a synthetic HTTP peer, not a deployed
backend. Neither `upToDate` nor an append ACK proves cluster freshness, an unforgeable
current head, or a production CAS configuration. Dedicated server admission and the
15-minute authorization window remain unimplemented.

```sh
pnpm --filter @lody/e2ee-core check
```

Signing and hashing use [Web Crypto](https://nodejs.org/api/webcrypto.html).
Verification uses pinned [noble-ed25519 3.2.0](https://github.com/paulmillr/noble-ed25519/tree/3.2.0),
with no transitive dependencies. Content encryption additionally uses noble-ciphers.
The optional Streams subpath also declares the pinned SDK dependency. Native Ed25519
verification is not sufficient: Node 22.23.1 accepted an identity public key and
public constant signature in our regression. All signing keys, including genesis
keys, must be canonical nonzero prime-subgroup points. Verification additionally
requires canonical prime-subgroup R (identity R permitted), S < L and
`zip215: false`. Curve operations are provided by the library, not custom code.
The optional `SubtleCrypto` parameter supplies native signing/SHA-256; the library's
async verifier uses platform Web Crypto SHA-512. No algorithm fallback is supplied.
Tests include [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032.html#section-7.1),
public edge vectors and a real Org weak-key admission regression.
Org admission encryption-key fields still have encoding/uniqueness checks only;
the key-envelope layer additionally checks canonical X25519 encoding and performs
KEM validation before returning encrypted secrets. Admission-time validation remains
to be integrated so unusable encryption keys cannot first enter the ledger.
