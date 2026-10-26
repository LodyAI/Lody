# E2EE foundation boundary

Status: draft
Translation: current

[中文](e2ee-foundations.zh.md)

A client receiving encrypted bytes first needs an unambiguous format and a
signature tied to the organization and document it intended to open. The
foundation package provides that check without enabling an encrypted workspace.

The caller supplies the independently trusted organization genesis, document
resource, epoch, purpose and signing public key. None is trusted merely because
it appears in a packet or URL. Content v0 retains `docEpoch = 0`; unsupported
versions and generations fail. Update encoding remains fixed: version byte, u32be Org
epoch, u16be document epoch, 32-byte signing key, 24-byte nonce, ciphertext/tag,
64-byte signature (143 bytes overhead). Snapshot purposes insert a u16be length
and the exact ASCII continuationOffset immediately after the signing key; their
overhead is 143 + 2 + offset bytes. The complete header binds signature and AAD. Document context binds genesis and resource; purpose and
optional external binding participate in authentication. The four document
update/snapshot purposes share key-derivation context, not authentication bytes.

Byte wrappers copy public material. Canonical CBOR rejects alternate encodings,
trailing input and unsupported types, with size/depth/array limits. Strict Ed25519
rejects invalid signatures, noncanonical or mixed-torsion points, identity public
keys A and identity nonce points R, and scalars S >= L. Both pure and native
verification apply this same preflight before the signature equation so native
provider differences cannot select a different accepted record set.

Signature validity is only one prerequisite. The foundation primitives (`@lody/e2ee-core/protocol`) do not verify current
membership, freshness, write permission, snapshot history or server admission.
The separate AEAD primitive derives a scoped content key with HKDF-SHA-256 and
validates XChaCha20-Poly1305 tags using caller-supplied context/header and binding.
New encryption requires a secure random 24-byte nonce. Tag validity alone does
not establish author identity or authority. It does not expose a signer, private-key export, platform storage,
transport or production feature switch. Platform custody and full content opening
remain separate work. This draft is not product or all-platform acceptance.

The separate HPKE epoch primitive preserves Base X25519/HKDF-SHA-256/ChaCha20-Poly1305,
info `lody-e2ee/hpke-epoch/v1\0` and canonical four-field ledger AAD. It seals only
a 32-byte epoch key to `enc32/ct48`, accepts externally owned device key handles,
and exposes no delivery or installation workflow. Host secure randomness is
required; async native completion precedes temporary-buffer cleanup and cancellation
completion. Outer signatures, current eligibility and epoch commitments remain
mandatory caller responsibilities; HPKE validity does not establish sender identity.

## Realtime RPC and presence (M5 review draft)

This section records the selected realtime direction: iroh first, encrypted
Streams RPC fallback, one shared signed encrypted frame and durable deduplication,
ledger-bound machine IDs, and execution freshness obtained by the machine itself.
The owner has selected these behavior boundaries, including the device identity
used by iroh; **this Spec revision remains draft**. The existing candidate byte
layout and limits below are unchanged; these choices do not approve a new ledger
encoding or open product channels. The machine admission format change is separate
work. Ordinary RPC, document content v0 and credential-binding/v1 stay unchanged.

### Shared content frame

Both transports carry exactly one content v0 frame per message: header39,
nonce24, encrypted body with tag16, signature64. No transport field supplies
authority. Derive with the existing `deriveContentKey`: pinned genesis,
current epoch, `docEpoch=0`, purpose 7/8/9, and resource. Requests and responses
use `rpc:<machineId>`; presence uses `presence:<roomId>`. Proposed identifier
encoding is 1..128 printable ASCII bytes without whitespace, with literal
prefixes (no URL normalization). Reject out-of-range IDs. One genesis maps to
one workspace; the host separately checks that fixed workspace binding.
Purpose is authenticated by content v0 even though it is absent from its header.
Request, response, presence and document leaves never substitute for each other.
No extra content additionalData is used in this proposed profile.

Proposed body encoding is fixed fields, not an outer JSON object. Integers are
unsigned big endian; u64 values must be <= 2^53-1. `text16` means u16 byte length
followed by strict UTF-8; `bytes32` means u32 byte length followed by exact bytes.
Reject truncation, trailing bytes, unknown tags and limits before allocation.
All listed limits include the entire plaintext body. Content v0 adds 143 bytes.
All timestamps are proposed as nonnegative Unix UTC milliseconds. Expired means
`now >= expiresAt`; presence requires `issuedAt <= now < expiresAt` and
`0 < expiresAt - issuedAt <= 60_000`. Local clock uncertainty invalidates reuse.

| Purpose    | Proposed plaintext layout                                                                  | Proposed maximum                           |
| ---------- | ------------------------------------------------------------------------------------------ | ------------------------------------------ |
| 8 request  | `version:u8=0, requestId:16, expiresAt:u64, method:text16, params:bytes32`                 | 1 MiB; method 1..128 printable ASCII bytes |
| 9 response | `version:u8=0, requestId:16, requestDigest:32, kind:u8, sequence:u32, payload:bytes32`     | 1 MiB per frame                            |
| 7 presence | `version:u8=0, incarnation:16, sequence:u32, issuedAt:u64, expiresAt:u64, payload:bytes32` | 64 KiB; TTL <= 60 seconds                  |

`requestId` and presence incarnation are host-generated secure random 16-byte
values. The request signer is the content header key. Target, genesis, epoch and
purpose come from the independently trusted scope, not a decoded body or URL.
`params` is the exact UTF-8 JSON produced by the existing method codec, validated
by that method after frame authentication; it is not reserialized for hashing.
JSON content does not choose a method, signer, target, ID or deadline. Binary
method output needs an explicit method codec, not implicit JSON coercion.

Response kinds are proposed as 0 progress, 1 final success, 2 final error.
`requestDigest` is SHA-256 of the **entire original signed encrypted request**.
Sequence starts at zero and strictly increases per request; exact duplicate
frames are ignored, different bytes at the same sequence conflict. A terminal
frame ends progress; sequence gaps allow a lost progress frame but never create
success. Success/progress payload uses the existing method's UTF-8 JSON codec;
error payload is `code:text16, detail:bytes32`, with code restricted to 1..64
ASCII letters, digits, `_` or `-`, and detail an explicitly permitted encrypted
method error DTO. Raw exceptions, paths, stacks and provider output stay in the
corresponding trusted host's diagnostics unless explicitly part of that DTO.
Response publication failure never replaces the stored business result.

One durable response owner atomically saves each exact sealed response frame
and its allocated sequence **before** publication, and retries those original
bytes. Restart never re-encrypts a payload under a committed sequence. Sealing
without that commit allocates no durable sequence; an uncertain commit must be
reconciled before sealing another frame or publishing.
After an unavailable/invalid response outbox, use a separately authorized result
query rather than inventing another original response. No response evidence is
automatically collected in this first version.

Every response/progress must match the caller's persisted original ID/digest,
genesis, target and epoch, and be signed by the independently bound target
device **while it remains valid**. Another valid member with the same epoch key
cannot reply for it. A request expiry blocks a new start, not delivery/query of
an already retained result. Result lookup is itself authenticated and authorized;
knowing an ID or digest does not grant access. A stored business result can be
wrapped in a newly authorized response to a separate result-query request;
this is not re-encryption or re-signing of the original request for retry.

### Machine binding: selected ledger admission

Machine `AdmitDevice` records bind the exact product machineId and the device
signing public key together under the approving personal device's ledger
signature. Obtain `machineId → signing key` from the locally verified ledger,
never from a directory row, a transport address or possession of an epoch key.
Keep existing member/account and machine ownership/sharing checks; this binding
does not grant new execution authority. Credential-binding/v1 remains unchanged
and is not a machineId proof. The separate machine-binding proof alternative is
not selected.

Within a workspace, at most one active device may bind a given machineId. A
replacement key for that machineId must revoke its previous key in the same
signed ledger record, so a competing admission cannot create two active targets.
The exact record encoding and its validation/vector changes belong to the
separate machine admission format work; this draft does not choose their bytes.
Old development machine records without machineId may continue authorized
document synchronization, but cannot establish realtime authority. Do not infer
a missing binding from metadata or migrate/re-sign their historical records.

### Permission freshness: machine-local authenticated read

A verified ledger proves continuity, not that a remote endpoint just returned
its latest state. A token, request timestamp, forwarded proof or received frame
does not establish execution freshness. The host verifies the caller's current
device/member role and existing machine ownership/sharing rules before a new
start **and every later action**. Guest and recovery devices cannot execute;
read-only queries use read permissions. Known revocation, epoch change,
rotationRequired or conflicting local evidence immediately blocks affected sends
and execution, including both transports and the durable dispatch path.

The execution machine starts its own authenticated latest-ledger read, captures
the local start time before network work, and verifies through that exact latest
boundary. Its in-memory authorization cache lasts no more than the remaining
part of 15 minutes from that read's start. Cached/forwarded pages do not restart
it. A slow read that consumes the window grants nothing. Intersect this deadline
with the request deadline and any applicable upstream credential deadline,
reserving clock/stop margin. No network is awaited under a global account lock.

Execution freshness is memory-only. Restart discards it and requires an online,
authenticated latest-ledger revalidation before accepting new remote execution;
local retained checkpoints and journal timestamps cannot restore that grant.
A live cache rejects clock rollback or uncertain suspend/resume elapsed time and
revalidates. Select and test the concrete clock, stop margin and sleep detection
per host without exceeding the bound. Source checkpoints/original windows may
remain diagnostic evidence, never a new authorization window. This does not
change the journal's separately accepted persistent expiry clock-floor behavior.
Offline document content/editing and already retained results remain available;
a failed refresh blocks new remote execution when its existing grant expires,
not unrelated local work. Started-but-uncertain operations are not automatically
restarted after revalidation.

### Iroh identity and trusted-host boundary

Iroh reuses the workspace device's Ed25519 identity: its EndpointId is the same
device signing public key. Only the trusted host supplies that device private
key to iroh; it is never exported to the renderer or exposed by an arbitrary-sign
IPC. An authenticated iroh peer still passes the shared frame, verified machine
binding, current member/device permission, freshness and execution-journal gates.
A transport connection does not grant workspace authority.

Before enabling this reuse, audit the concrete iroh TLS and discovery signing
paths for domain separation from ledger/content signatures; the selected identity
is not evidence that this audit has passed. Native SDK, discovery/relay settings
and platform acceptance remain implementation work. An unavailable or slow iroh
connection must leave encrypted Streams RPC usable with the same original
request ID/frame and one machine-side execution claim.

### Durable identities, result lookup and collection

Before sending, save the exact signed encrypted frame and fixed request ID.
Before acknowledging reception, the machine saves that original in one journal
shared by both transports. The logical identity is
`(genesis, workspace, targetMachineId, requestId)`; requester and exact frame are
immutable attributes. A different requester or different original under that
identity is a conflict, never another execution. Record the original expiry;
neither re-signing nor forwarding renews it.

The journal records received, started, completed and an uncertain outcome after
a start without durable completion. Atomically claim a received entry before
the first business side effect; only one caller obtains the start permit.
A crash after that claim is uncertain even if no side effect can be proved.
Never automatically take it over or replay it. Reconcile using existing
userTurnId/steer/fork execution evidence; associate the same business operation
with the durable Meta dispatch path so it cannot bypass the journal.

In particular, `session/dispatch-turn` currently returns a delivery ACK from
`offerRpcTurn`, not completion of an agent turn. In the proposed profile its
accepted/queued receipt is progress, correlated to the original userTurnId;
it must not mark the execution journal completed. The actual agent-start gate
claims the journal, and business completion records the final outcome. An ACK
does not permit the persistent watcher to start a second copy. Other methods
retain their explicitly documented completion semantics.

Persist the business outcome before response delivery or auxiliary cleanup.
Keep completed outcomes immutable and queryable on response loss or cleanup
failure. Journal errors block only work depending on it; preserve the file and
original cause at the host diagnostic boundary. Next calls may reopen after I/O
recovers; unreadable data is never an empty journal. No timeout steals ownership.

**Initial collection rule: no automatic collection.** Passing expiresAt does not
delete original, result or deduplication evidence. Explicit acknowledgement alone
also does not make the ID reusable. A later size/retention policy must specify
result consumption, uncertain operations, durable retired-ID evidence and backup
rollback before any body collection is enabled. Capacity exhaustion rejects new
work without evicting evidence. Exact originals are needed while retransmission
or conflict comparison remains supported; a compact tombstone policy is not yet
approved. Presence is ephemeral and never enters this journal or history.

Presence authenticates the expected sender, genesis, room, epoch and original
TTL. Reject forged, cross-room, expired, future-issued or oversized frames before
updating state. Keep sequence state per sender/incarnation only for its lifetime;
bad presence affects only that sender's state, never an unrelated document.

## Format compatibility

**Freeze point.** Ledger v1 (record version 1, the `sig/v1` and `rec/v1` domains and the operation codes in the [permission-ledger Spec](e2ee/permission-ledger.zh.md)) becomes permanent when a production deployment first enables encrypted workspace creation, because only then can a ledger exist that must never break. Merging code does not freeze it. Until that point the format may still change, but only with owner approval, and the same change regenerates `packages/e2ee-core/test/ledger-v1-vector.json` with its independent generator; development and staging ledgers created earlier may stop verifying. Production creation must not be enabled before a format review confirms that the record shapes, operation codes, signing domains and the open items in permission-ledger §9 (recovery vault and trust-anchor encoding, rotation after self-revocation, recovery-device enrollment order) need no change to how existing records encode or verify. After the freeze the vector is never regenerated.

**What freezes.** Every record that v1 accepts at a position must stay accepted by every later client, with the same bytes, hashes and resulting ledger state. New behavior, including relaxed or extended permissions, takes effect only through records after a capability declaration; it never changes how an existing record verifies.

Ledger evolution is append-only:

- A new operation becomes valid only after a capability declaration (operation tag 9) earlier in the same ledger. The declaration lists strictly ascending nonzero u32 capability codes, is signed by an Owner or Admin personal device and is monotonic. A client that does not implement a declared capability verifies the preceding records and stops at the declaration with `upgrade-required`; it never reports corruption or skips the record. Writers and hosts refuse a declaration they do not implement and any operation whose capability was not declared earlier.
- Changing the cipher suite or another genesis-level parameter creates a new ledger with a new genesis. The old ledger is never rewritten; it ends with a link record introduced through a capability, as MLS ReInit links a replacement group.

Every other format remains current-only. Content, journal, local-store and snapshot formats have no deployed data: support only the current format for each entrypoint, with no old-format decoders, dual readers, schema upgrades, legacy imports or compatibility facades. Snapshots can always be rebuilt from full v1 history, so a snapshot format change does not break ledger compatibility. Unsupported formats fail without rewriting their input. Normal reopening of current stores, verified history within the current ledger and epoch-key history recovery remain required. This scope choice does not select any pending replacement format or approve production activation.

## Retained verified state (proposed)

Full replay costs about 5.4 ms per record on an idle desktop-class host (4,096 records: 22 s); extending a held view by one record costs about 5 ms. Replaying from genesis on every request is therefore not viable for a host or a client. This section proposes a core entry that lets a party resume from **its own** previously verified state. It does not change the ledger v1 record format. See the [proposal note](../.agents/notes/proposed/architecture/2026-10-19-e2ee-retained-ledger-state.md).

- **Export.** `exportVerifiedState(view)` returns the canonical state encoding (the same deterministic encoding that snapshot bodies use, so one state has exactly one byte representation), its genesis, length, head and `stateDigest`. The digest is computed once, at export.
- **Restore.** `restoreVerifiedState({ bytes, genesis, length, head, stateDigest? })` decodes canonically and rejects malformed input with typed errors. It does not re-verify signatures or re-validate key curve points: the bytes come from the same party's own storage, which that party already trusts. When the caller passes the `stateDigest` it stored with the bytes, restore recomputes it from the bytes (one SHA-256, no second encoding) and fails with `state-digest-mismatch` on a difference. This detects corrupted or mismatched rows, not a writer who can replace both values; without the digest, restore behaves as before. A restored view supports `extendLedger` exactly like the view that was exported.
- **Scope of authority.** Retained state is authority only for the party that exported it, for its own decisions (a host's write admission, a client's local view). It is never accepted from another party. Joining another party's state still uses endorsed snapshots.
- **Continuation.** New records are read from the retained length onward; the first must reference the retained head. A mismatch means the external store rolled back or forked and fails closed. This check is about untrusted storage, not about the retained state.
- **Completeness.** Retained state must contain every replay fact needed to verify the next record identically to a full replay: every membership ever admitted with its user, every device ever admitted with its encryption key and membership, current roles and device kinds, closed joins, epoch state, history packets, and declared capabilities once any exist. Used keys, membership IDs and commitments are these tables, and every device ever admitted keeps its historical author. Original epoch publication records are not retained: a restored view reports them unavailable, so it cannot stage keys for epochs published before its restore point.
- **One state encoding.** Retained state, endorsed snapshots and the comparison digest share one authorization-state encoding, so all three sources (full replay, qualified snapshot import, retained restore) agree on the state, its digest and every author at the same position. The retained envelope adds only the verification source, which survives a round trip and is never upgraded; verified hashes before the restore point are not kept. Layout and acceptance: [compact state note](../.agents/notes/proposed/architecture/2026-10-20-e2ee-compact-ledger-state.md).
- **Digest use.** `stateDigest` identifies a state for cross-party comparison (comparison notes) and for background audits. Restore checks it only when the caller supplies it, which costs one hash and no re-verification.
- **Background audit (deferred).** A full replay from genesis compared with the retained digest can catch bugs or storage corruption. It is optional, not part of this change, and may run outside the host's request runtime (for example a separate worker that reads the stored ledger and the retained digest). If added, a mismatch is an incident that stops writes for that ledger until resolved.
- **Format.** The retained encoding is current-format only and versioned: retained envelope version 2, snapshot body version 2 and the `snapshot-digest/v2` digest domain (version 1 was the pre-compact layout). Any other version fails with `unknown-version`; the party then discards its retained state and rebuilds it by one full replay of v1 history. Changing the encoding bumps these versions.
- **Reads.** A host serving history pages needs no verification on the read path; clients verify what they receive. Host verification belongs to write admission.
- **Local stores.** If adopted, clients may restore their local retained state on open instead of revalidating all stored records, which supersedes the full revalidation described below.

## Local epoch protection boundary

A recipient must be able to reopen a durably retained installed epoch key without
requiring its original sender to remain active. Trusted host composition may
initialize one native protect/unprotect capability; ordinary consumers continue
using opaque keys. Native protection binds purpose, Org genesis, recipient, epoch
and commitment together with the key. A compromised host can copy plaintext;
this contract does not claim OS isolation or reversible erasure of those copies.

Installation reporting must follow durable save, actual reload/unprotect and
independent commitment verification. Failure must never claim reported installation.
Native settlement and temporary cleanup precede cancellation/Scope completion.
No plaintext fallback or production composition is allowed. Native adapter choice,
recovery file/wrapping/concurrency and native custody remain separate decisions; publisher availability uses
[stage-before-CAS](e2ee/publisher-key-recoverability.md). This Spec revision stays draft; accepted boundary direction
and executed synthetic tests do not approve this entire revision or native custody.

[Host contract and validation boundary](../packages/e2ee-core/docs/workflows.md#installedepochkeys-and-installedepochhistory).

## Evidence

[Module and entrypoints](../packages/e2ee-core/README.md),
[fixed vectors and negative cases](../packages/e2ee-core/test/foundation.test.ts),
[source fingerprints](https://github.com/LodyAI/Lody/blob/5f97599e60700d6185834632df85922ea0d73ec6/packages/e2ee-core/provenance.json).

## Settled content v0 and snapshot continuation

Content v0 with docEpoch=0 is the selected format, replacing the proposed v2;
there is no v2 reader. All four document purposes share one document leaf to
support future per-document grants; distinct purpose-bound AAD/signatures stop
cross-purpose substitution. Update wire bytes are unchanged.

Snapshot provider header is exactly [4]; the offset lives in the encrypted-content
frame's authenticated clear header, never an unauthenticated provider extension.
The admission gateway checks that it is a real record boundary at or before the
actual head before forwarding to content-blind Streams. The reader compares the
exact SDK snapshot continuation after authenticating and decrypting. Tampering,
transplanting, a future offset or a mid-record position fails without advancing
the durable document/cursor pair. Opaque offsets are never numerically ordered
by clients. Native boundary lookup is a host capability, not snapshot authority.

Generic ASCII offsets use the u16 length bound; the released SDK's 4096-byte
sealing-overhead limit imposes a smaller adapter bound. A snapshot plus subsequent
updates bootstraps through actual Loro/Flock consumers. These design decisions do
not mark this revised draft approved or enable product encryption.

## Local SQLite persistence

The client and operating system are trusted under the whitepaper threat model.
Current-store creation/open checks application/version and fixed genesis/recipient
bindings, uses WAL/FULL and transactions, and revalidates stored ledger records on
open. SQL rows do not establish authority. Operations retain first-original
readback and genuine-ledger rollback-pin comparisons; unchanged head/count pins
produce no write. They do not scan old rows or audit schemas, triggers and local
write counters to detect an unrelated local process changing the database.

Snapshot publication keeps ciphertext bodies only for current and Pending.
Accepting a new current clears the old Accepted body's bytes in the same
transaction, retaining offset, signer, SHA-256 digest, original credential window
and phase. Archived identities remain idempotent, reject different bytes at the
same offset and can never become current again. Capacity budgets count retained
bodies rather than archived identities.
