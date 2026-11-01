# E2EE foundation boundary

Status: approved
Translation: current

Approved revision: [`e4351fda5f0455b121b7e80db8ebc79752dee862`](https://github.com/LodyAI/Lody/commit/e4351fda5f0455b121b7e80db8ebc79752dee862)
Approval: 2026-10-28, reviewed and approved by the owner-authorized coordinator
(session `b12f1597`); [approval record](https://github.com/LodyAI/Lody/pull/1894).

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
remain separate work. Spec approval is not product or all-platform acceptance.

The separate HPKE epoch primitive preserves Base X25519/HKDF-SHA-256/ChaCha20-Poly1305,
info `lody-e2ee/hpke-epoch/v1\0` and canonical four-field ledger AAD. It seals only
a 32-byte epoch key to `enc32/ct48`, accepts externally owned device key handles,
and exposes no delivery or installation workflow. Host secure randomness is
required; async native completion precedes temporary-buffer cleanup and cancellation
completion. Outer signatures, current eligibility and epoch commitments remain
mandatory caller responsibilities; HPKE validity does not establish sender identity.

## Realtime RPC and presence (M5 review draft)

Remote execution needs the same authority and execution evidence whichever route
wins. For the MVP, use **encrypted Streams RPC → encrypted history/Meta durable
dispatch** as the final fallback. Keep that durable path available when Streams
RPC fails; it must reach the same actual-start claim, not a second execution path.
Iroh is a later acceleration layer, outside the MVP. Ordinary workspaces keep
their existing behavior. RPC and durable content never fall back to plaintext;
MVP presence is the separately approved minimal plaintext metadata channel below.

**This concrete byte revision is approved as recorded above.** The owner approved both format
choices below on **2026-10-28**: the 1 MiB RPC limit includes content v0's
143-byte overhead, and
RPC resources use canonical unpadded base64url of the ledger machineId bytes.
The RPC body layout follows PR-25, merged as
`c7b3c71512e2bdf26b14817fc8ff56cbd730f509`, with source pinned at
`daee5751fde6698e50960ca6a5627191c887e297`; that code is evidence of candidate
bytes, not final Spec approval or a shipped realtime capability.

### Shared content frame and resource bytes

Each encrypted RPC message carries exactly one content v0 frame:
`header39 || nonce24 || ciphertext || tag16 || signature64`. Derive with the
existing `deriveContentKey`: pinned genesis, current epoch, `docEpoch=0`, purpose
8/9 and the exact resource. Purpose is authenticated despite being absent from
the header. Use no extra content additionalData in this profile. Request,
response, presence and document leaves never substitute for each other.
Transport metadata supplies no authority; the host separately checks the fixed
genesis-to-workspace binding and independently trusted target/signer.

**Resource choice — owner approved (2026-10-28):** requests and responses use
`rpc:<encodedMachineId>`, where encodedMachineId is RFC 4648 section 5 base64url
of the exact ledger machineId's strict UTF-8 bytes, **without `=` padding**. The
ledger permits 1..256 bytes, preserves a leading BOM, rejects lone surrogates and
malformed UTF-8, and performs no Unicode normalization. Encode those original
bytes without trimming, case folding, URL decoding or other normalization.
The encoded segment uses only `A-Z a-z 0-9 - _`, is 2..342 ASCII bytes, and the
complete resource is at most **346 ASCII bytes** including `rpc:`. For example,
`a` becomes `rpc:YQ`, and `机器` becomes `rpc:5py65Zmo`.
Reject padding, alternate alphabets, whitespace, impossible lengths, nonzero
unused pad bits and any spelling that fails exact decode/re-encode equality;
also validate the decoded 1..256-byte strict UTF-8 ledger identity. Thus every
valid ledger ID has exactly one lossless resource spelling, including IDs longer
than 128 bytes or containing non-ASCII characters. A decoded name alone grants
no machine authority. This resource codec is absent from PR-25's body codec.

### MVP presence: minimal plaintext (owner approved 2026-10-28)

Encrypted workspaces use the existing plaintext `presence` ephemeral channel
with its **90-second TTL** (`LODY_PRESENCE_TTL_MS = 90_000`), not encrypted
presence. Keep the existing 30-second heartbeat and bounded publication rules.
These IDs, state enums and timestamps are metadata the service can infer from
connections, traffic and accounts; encrypting them offers little additional
privacy while adding complexity and availability risk. This is the selected
metadata disclosure, not a plaintext fallback for RPC or document content.

Before any encrypted-workspace presence publication, construct a new record by
this **closed allowlist**, including its nested status fields:

| Record kind       | Allowed fields                                                        |
| ----------------- | --------------------------------------------------------------------- |
| `machine`         | `kind`, `machineId`, `instanceId`, `updatedAt`                        |
| `session`         | `kind`, `sessionId`, `machineId`, `instanceId`, `status`, `updatedAt` |
| `session-viewing` | `kind`, `userId`, `instanceId`, `sessionId`, `since`, `updatedAt`     |

`kind` is one of the three literal tags above. Session `status` contains only
`type` = `running` / `requestPermission` / `initializing`, plus the existing
optional enum fields: `activity` = `image_generation`, `phase` = `finalizing`,
and `stage` = `git-clone` / `managed-runtime` / `acp` / `resuming`, where valid
for that status type. IDs must remain actual existing identifiers, not labels
or text carriers; `since` and `updatedAt` are validated timestamps.

**Strip every unlisted field before it enters the local ephemeral store or any
local/cloud presence publisher.** In particular, never publish `status.detail`,
free-text progress/errors, machine/user/session names, titles, paths, commands,
prompts or content snippets. A length limit or read-side stripping is insufficient:
the plaintext must already be filtered before transmission. Preserve existing
room/account access checks, freshness and online/offline/unknown semantics;
presence grants no execution authority, enters no journal/history, and a malformed
entry cannot block unrelated documents. Ordinary-workspace payloads are unchanged.

**Encrypted presence is outside the MVP.** Purpose 7 seal/open primitives and the
presence body codec merged by [#1990](https://github.com/LodyAI/Lody/pull/1990)
are **reserved, unused by the MVP**. Their 64 KiB body and ≤60-second encrypted-body
TTL belong only to that reserved codec; they are not MVP presence limits and must
not replace the existing 90-second TTL. No `presence:<roomId>` content resource or
purpose-7 frame is sent by the MVP. RPC continues to use purposes 8/9 unchanged.

### RPC body bytes and limits

Bodies use fixed fields, not an outer JSON object. Integers are unsigned big
endian; u64 values must be at most `2^53-1`. `text16` is a u16 byte length and
exact ASCII bytes (a strict UTF-8 subset); `bytes32` is a u32 byte length and
exact opaque bytes. Reject truncation, trailing bytes, unknown tags, invalid
text/integers and size limits before allocation/copying. Decoded byte fields
own their storage, including for offset Buffer inputs.

| Purpose    | Plaintext field order                                                                  | Limit                                                                       |
| ---------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 8 request  | `version:u8=0, requestId:16, expiresAt:u64, method:text16, params:bytes32`             | Complete sealed frame ≤1,048,576 bytes; method 1..128 bytes in `0x21..0x7e` |
| 9 response | `version:u8=0, requestId:16, requestDigest:32, kind:u8, sequence:u32, payload:bytes32` | Each complete sealed frame ≤1,048,576 bytes                                 |

**RPC limit choice — owner approved (2026-10-28):** body size is at most **1,048,433 bytes**
(`1,048,576 - 143`), not 1 MiB plus content overhead. Request body size is
`31 + methodBytes + paramsBytes`; response body size is `58 + payloadBytes`.
Transport envelopes are outside these RPC content-frame bounds. Generic document
content limits do not change.

Response kind is exactly 0 progress, 1 final success, or 2 final error. A final
error's entire payload is `code:text16, detail:bytes32`, **without another version
byte**. Code is 1..64 ASCII letters, digits, `_` or `-`; payload size is
`6 + codeBytes + detailBytes` and at most 1,048,375 bytes, leaving the response's
58-byte prefix inside the RPC body bound. Both response encoding and decoding
validate this nested error layout. Empty params, success/progress payloads
and error detail are permitted by the RPC body codec; the method schema applies
its own requirements after authentication.

Request IDs are host-generated secure random 16-byte values. RPC timestamps are
nonnegative Unix UTC milliseconds. Expired means `now >= expiresAt`. The RPC body
codec does not check current time, replay state, permissions or request freshness.

Method params, success/progress and error details remain exact opaque bytes for
the authorized method codec; JSON methods use their explicit UTF-8 JSON codec,
without reserialization for hashing. Binary output requires an explicit codec.
Decoded payloads cannot select another method, signer, target, ID or deadline.
Error detail is an explicitly permitted encrypted method DTO; raw exceptions,
paths, stacks and provider output stay in the trusted host's diagnostics unless
explicitly part of that DTO.

`requestDigest` is SHA-256 of the **entire original signed encrypted request**.
Sequence starts at zero and strictly increases per request without u32 wrapping;
exact duplicate frames are ignored, different bytes at the same sequence
conflict. A terminal frame ends progress; gaps allow lost progress but never
create success. Stateful correlation and sequencing belong to integration, not
the pure body codec.

One durable response owner atomically saves each exact sealed response frame and
its allocated sequence **before publication**, then retries those original bytes.
Restart never re-encrypts under a committed sequence. An uncertain commit must be
reconciled before another seal or publication. If the response outbox is
unavailable/invalid, use a separately authorized result query rather than inventing
another original response. Publication or cleanup failure cannot replace a saved
business outcome. No response evidence is automatically collected.

Responses/progress must match the caller's retained original ID/digest, genesis,
target and epoch, signed by the independently bound target device **while it
remains valid**. Another member holding the epoch key cannot reply for it.
Request expiry blocks a new start, not delivery/query of a retained result.
Lookup itself needs authentication and read authorization; an ID/digest grants
no access. A retained outcome may become a fresh response to a separate authorized
query; that does not re-sign/re-encrypt the original request for retry.

### Machine binding and current-only development state

Machine `AdmitDevice` signs the exact machineId and device public keys together;
machine possession also covers that machineId. Obtain `machineId → signing key`
only from a genuine locally verified ledger, never directory rows, addresses or
possession of an epoch key. Keep existing member/account and machine
ownership/sharing checks. Credential-binding/v1 still binds the pairing exchange
to its session; it is not the machineId proof.

At most one active device binds a machineId in a workspace. Replacement names the
same member's currently active device with that machineId and revokes its key in
the same signed record. The current pre-freeze machine tag4/possession format is
already implemented; it adds no new operation or capability declaration. See the
[permission-ledger contract](e2ee/permission-ledger.zh.md) and the public
[machine binding decision](../.agents/notes/proposed/architecture/2026-10-27-e2ee-machine-ledger-binding.md).

Old development ledgers without the required machineId are unsupported: recreate
them with the current format. They do not retain a document-sync compatibility
path; do not add legacy decoding, migration, metadata guesses or re-signing of
history. Production has no encrypted workspaces requiring that compatibility.
This does not authorize erasing uncertain operations or execution evidence.

### Machine sharing policy (pending approval increment)

**Increment status: draft; not covered by the approved revision above.** The
existing approved machine identity and execution contracts remain in force.

Each machine binding generation has one complete encrypted owner-personal policy:
machine sharing plus shared localProjectIds. New generations and absent projects
are private. Enabling a project also enables its machine atomically; disabling
the machine retains project records. Workspace Owner/Admin has no cross-member
override. All-team includes future qualified members; Guest/recovery never execute.

Generation is the initial machine admission signing key of the current uninterrupted
atomic-replacement chain. Genuine ledger inclusion and exact replaces links prove
it; server counters or resource metadata cannot choose it. Atomic replacement
preserves this root and policy. Revocation/removal followed by readmission starts
a new root/resource even for the same member/machineId. The old generation remains
terminal. New sharing requires new explicit owner intent and starts at revision
1/null parent, without importing old grants, pins or deleted policy history.

Signed current-only policy v2 binds workspace ID, pinned genesis, machineId,
owner membership instance, generation, revision/previous original-frame digest,
requestId, complete state, personal signer and descriptive issuedAt. A distinct
business signature/AAD domain and generation-qualified resource use existing
content-v0 encryption, docEpoch zero; no ledger record or state format changes.
Within a generation, server CAS orders immutable originals and checks current
ledger generation plus full head status/scope/position in the same transaction.
Old pending requests cannot cross removal, even when numeric positions match.
Sharing withdrawal is a new signed policy; physical cleanup is scoped to the
closed generation and cannot erase successor commits. Storage tombstones never
substitute for verified pins. Exact retry receipts never resurrect cleaned frames.

Before each start and later authorized action, check current ledger eligibility,
actual machine key/generation and the current owner-personal policy; actual local
projects also need their own switch. A revoked signer invalidates execution on
its old policy. Historical owner-personal data may preserve state for a new
explicit same-generation intent, but cannot grant execution or skip history.
Withdrawal blocks new starts/later actions without killing already running tasks.
A separate account display query returns only ciphertext/untrusted metadata.

Observed withdrawal invalidates authorization immediately. A strictly less than
15-minute memory cache bounds time since this machine's authenticated latest read
started, intersected with ledger/request deadlines. It does **not** prove an unknown
withdrawal takes effect within 15 minutes if the server continuously withholds new
heads: signatures/chains detect known rollback/forks, not globally latest state.
On 2026-10-28, the owner confirmed acceptance of trusting the server not to
continuously withhold newer heads; the MVP adds no signed freshness proof. Restart or
clock uncertainty requires revalidation; unrelated content/local work stays usable.
The machine-sharing host performs these reads, caches and execution checks for the CLI;
product enablement remains separate. See the [proposed sharing decision](../.agents/notes/proposed/architecture/2026-10-28-e2ee-machine-sharing.md).

**Derived work (proposed revision, draft).** On 2026-10-31 the owner chose to restore
work that a shared member's turn derives through the machine (child Sessions, chat,
Roles, continuations, agent control) by reusing the signed-original chain. The machine
writes such an input with `derivedFrom: { sessionId, userTurnId }` inside the signed
row, only while that origin turn is active and only for this machine. At start, the
machine verifies the origin as the member's own signed, non-derived Turn and authorizes
the member's rights ∩ the owner's sharing policy ∩ every reached project. The start
deadline is the origin's signed deadline plus 15 minutes. Derivation is one level deep,
with at most 20 inputs per origin. Owner work is unchanged. Cross-machine derivation is
not implemented and fails closed; a future version would use a user-approved signature
from the originating member's personal device. See [derived work](../.agents/notes/proposed/architecture/2026-10-31-e2ee-shared-member-derivation.md).

### Permission freshness and the separate durable expiry clock

A verified ledger proves continuity, not a fresh latest read. Tokens, timestamps,
forwarded proofs and received frames do not grant execution freshness. Before a
new start **and each later action**, check current member/device roles and existing
machine ownership/sharing rules; Guest and recovery devices cannot execute.
Read queries need read permissions. Known revocation, an incompatible epoch or
conflicting evidence stops affected sends/execution across all delivery routes.
**`rotationRequired` is an administrator advisory only:** keep prompting for key
rotation, but the flag alone blocks neither new sealing, sending nor execution.
Current verified authorization and usable epoch keys remain necessary.

The execution machine initiates its own authenticated latest-ledger read and
records local start time **before network I/O**. Verify through that read's latest
boundary; cache only the remaining part of a maximum **15 minutes from that
start**, in memory. Slow or failed reads and forwarded/cached pages cannot renew
it. Intersect with request/upstream deadlines and reserve clock/stop margin;
never wait on network under a global account lock. Restart discards this grant
and requires online authenticated revalidation before new remote execution.
Rollback or uncertain suspend/resume elapsed time invalidates the live cache.
Retained checkpoints and journal timestamps cannot restore execution freshness.
Offline documents/editing and retained results remain available; expired freshness
blocks new remote execution, not unrelated local work. Revalidation never restarts
an uncertain operation.

The journal's **persistent expiry clock is a different mechanism**, not an
execution grant. Current schema 3 retains a nondecreasing floor per
`(genesis, workspaceId)` across reopen. With an independently authenticated current
reference, claim rejects local time or the retained floor more than 600,000 ms
ahead; accepted claims use `max(reference, retainedFloor)`. Without a reference,
use `max(localNow, retainedFloor)` in that workspace. Never use frame timestamps
as trusted time. Explicit evidence-preserving reset can clear a poisoned floor
while retaining retired request IDs; it neither renews original deadlines nor
restores freshness or replay authority. Follow the public
[journal recovery decision](../.agents/notes/proposed/bug-fix/2026-10-27-e2ee-realtime-journal-recovery.md).

### MVP routes and latency acceptance

The MVP uses encrypted Streams RPC as its realtime path. If it is unusable, retain
**encrypted history/Meta durable dispatch as the final fallback**. Retry the
original ID and exact signed ciphertext. Durable dispatch retains the same
business identity (`userTurnId` where applicable) and original request correlation;
both routes pass the same actual-start claim and current authorization. A durable
arrival does not refresh the original deadline or start a second operation.
MVP delivery and acceptance must not depend on an iroh connection or SDK.

The acceptance target is **send-to-actual-execution-start ≤1 second**, measured
from sender acceptance of the send to the machine's actual-start boundary, not
to a receipt ACK or business completion. Measure ordinary/encrypted paths and
transport/fallback selection separately under stated conditions. Offline durable
catch-up has no one-second delivery guarantee; a passed deadline still forbids
a new start. No latency result is claimed by this documentation revision.

### Later acceleration: iroh (outside the MVP)

The owner deferred iroh from the MVP on **2026-10-28**. The identity decision is
retained for that later layer: iroh reuses the workspace device's Ed25519
identity, so EndpointId equals its signing public key. Only the trusted host supplies the private key, with no renderer
export or arbitrary-sign IPC. A connected peer still passes shared-frame,
verified-binding, current-permission, freshness and execution-journal checks.
The 2026-10-28 owner decision records that the domain-separation review found no
confusion between the signing protocols. That finding is not native SDK/key
lifetime or installed-platform acceptance. A later iroh accelerator must preserve
the same original ID/ciphertext, authorization and actual-start claim, and must
not delay usable encrypted Streams RPC or its durable fallback.

### Durable identities, actual start and retained outcomes

Before a realtime send, retain the exact signed ciphertext and fixed ID. Before
receipt ACK, save the original in the shared journal. Identity is
`(genesis, workspace, targetMachineId, requestId)`; requester, original bytes and
original expiry are immutable. Another requester or another original at that
identity is a conflict, not another execution. Forwarding never renews expiry.

The journal retains received, started, completed and uncertain outcomes. Atomically
claim received **immediately before the first business side effect**; one winner
gets a start permit. A crash after claim remains uncertain even if no side effect
can be proved. Never automatically take over or replay. Reconcile using existing
userTurnId/steer/fork evidence, including arrivals through encrypted history/Meta.
A reception-only journal cannot fence durable dispatch after restart.

`session/dispatch-turn` returns an `offerRpcTurn` delivery ACK, not completed agent
work. Accepted/queued is progress tied to the original userTurnId, not journal
completion. The actual agent-start boundary claims the journal; business completion
saves the final outcome. Other methods retain their documented completion semantics.

Persist the business outcome before response delivery or auxiliary cleanup.
Completed results remain immutable and queryable after response loss or expiry.
Journal errors block only dependent work; preserve evidence and original causes,
allow reopening after I/O recovery, and never treat unreadable state as empty.
Timeouts cannot steal ownership.

**No automatic collection:** expiry or acknowledgement deletes neither originals,
results, responses nor deduplication evidence, and never makes an ID reusable.
Later bounded retention needs an approved policy for result consumption, uncertain
work, durable retired IDs and backup rollback. Until then, exhausted capacity
rejects new work without evicting evidence. MVP presence follows the separate
minimal-plaintext allowlist and 90-second ephemeral channel contract above.

### Revision evidence and limits

The [public source audit](../.agents/notes/proposed/architecture/2026-10-26-e2ee-realtime-contract.md#source-audit-and-integration-boundary)
pins merged primitives, machine binding and schema-3 journal to public main
`76a4f28e8f22c0b405e57b731fb0a1e49c42d8a3`. Candidate body bytes and independent
vectors from merged #1990 are pinned to [PR-25 source](https://github.com/LodyAI/Lody/blob/daee5751fde6698e50960ca6a5627191c887e297/packages/loro-streams-rpc/src/e2ee-wire.ts)
and its [vectors](https://github.com/LodyAI/Lody/blob/daee5751fde6698e50960ca6a5627191c887e297/packages/loro-streams-rpc/tests/fixtures/e2ee-wire-v0.json).
Existing presence fields and 90-second TTL are defined in
[shared presence](../packages/shared/src/presence.ts) and the
[channel contract](loro-ephemeral-presence-channel.md). Its general schema still
allows free-text `status.detail`; the encrypted-workspace publish allowlist is
an integration requirement, not behavior established by this documentation.
Resource encoding, authenticated transport/freshness, sender outbox, actual
execution and durable fallback wiring, result-query authorization, iroh custody,
installed-platform and latency acceptance are not established by those subsets.
The complete Spec revision `e4351fda` was approved on 2026-10-28 through the
owner-authorized coordinator review recorded above. Spec approval does not enable
product channels or establish runtime acceptance.

## Format compatibility

**Freeze point.** Ledger v1 (record version 1, the `sig/v1` and `rec/v1` domains and the operation codes in the [permission-ledger Spec](e2ee/permission-ledger.zh.md)) becomes permanent when a production deployment first enables encrypted workspace creation, because only then can a ledger exist that must never break. Merging code does not freeze it. Until that point the format may still change, but only with owner approval, and the same change regenerates `packages/e2ee-core/test/ledger-v1-vector.json` with its independent generator; development and staging ledgers created earlier may stop verifying. Production creation must not be enabled before a format review confirms that the record shapes, operation codes, signing domains and the open items in permission-ledger §9 (recovery vault and trust-anchor encoding, rotation after self-revocation, recovery-device enrollment order) need no change to how existing records encode or verify. After the freeze the vector is never regenerated.

**What freezes.** Every record that v1 accepts at a position must stay accepted by every later client, with the same bytes, hashes and resulting ledger state. New behavior, including relaxed or extended permissions, takes effect only through records after a capability declaration; it never changes how an existing record verifies.

Ledger evolution is append-only:

- A new operation becomes valid only after a capability declaration (operation tag 9) earlier in the same ledger. The declaration lists strictly ascending nonzero u32 capability codes, is signed by an Owner or Admin personal device and is monotonic. A client that does not implement a declared capability verifies the preceding records and stops at the declaration with `upgrade-required`; it never reports corruption or skips the record. Writers and hosts refuse a declaration they do not implement and any operation whose capability was not declared earlier.
- Changing the cipher suite or another genesis-level parameter creates a new ledger with a new genesis. The old ledger is never rewritten; it ends with a link record introduced through a capability, as MLS ReInit links a replacement group.

Every other format remains current-only. Content, journal, local-store and snapshot formats have no deployed data: support only the current format for each entrypoint, with no old-format decoders, dual readers, schema upgrades, legacy imports or compatibility facades. Snapshots can always be rebuilt from full v1 history, so a snapshot format change does not break ledger compatibility. Unsupported formats fail without application-level rewriting of their schema or committed evidence. SQLite may perform its own transaction rollback recovery and WAL checkpoint while opening or closing a database, including before the application can identify and reject an unsupported version; these native operations may change physical files but must preserve committed logical data and format. This does not permit application migrations or rebuilding an unsupported store. The host execution journal has a narrow operator-recovery exception: rename and retain an unsupported store, report its evidence path, and require explicit local reset before provisioning a fresh journal. Reset never imports or automatically re-executes archived work; current-format request IDs remain fenced across reset. A provably empty interrupted first creation may finish initialization. See the [MVP recovery decision](../.agents/notes/proposed/bug-fix/2026-10-27-e2ee-realtime-journal-recovery.md). Normal reopening of current stores, verified history within the current ledger and epoch-key history recovery remain required. This scope choice does not select any pending replacement format or approve production activation.

## Machine identity before the ledger freeze

The owner-approved pre-freeze change extends existing machine AdmitDevice (tag4),
without a new operation, capability code or tag9 declaration. Both the approving
record and machine possession proof bind machineId using the same strict UTF-8
byte string, 1..256 bytes, with no normalization. Producers reject invalid strings;
verifiers reject invalid UTF-8, empty and oversized identities. Byte-distinct IDs
stay distinct. Personal-device possession is unchanged. Session IDs remain one-time
pairing context bound by the separate bindingSignature, never permanent ledger facts.

Only one device may currently bind a machineId within one workspace. Replacing it
requires the existing same-member personal-device authority and revokes the exact
old key while admitting the new one in the same record. Historical keys stay
non-reusable; rotationRequired advises administrators to update keys without blocking
new seals or workspace use. Snapshot, retained and digest version 4 preserve the binding
and historical device kind.
Old developer machine records require workspace recreation, without a legacy reader
or migration. The independent v1 vector is regenerated under this explicit pre-freeze
approval. This does not approve production activation. The generic advisory permission
policy is adopted from [#1956](https://github.com/LodyAI/Lody/pull/1956); this ledger
change adds no send guard.

## Account-wide personal device pairing (pending approval increment)

**Increment status: draft; not covered by the approved revision above.** The owner
approved the direction on 2026-11-01; this text awaits owner approval. Until then the
existing explicit pairing exchange stays in force. Rationale, alternatives and the SAS
derivation are in the [proposal](../.agents/notes/proposed/architecture/2026-11-01-e2ee-account-personal-pairing.md).

**Scenario.** A signed-in user opens an encrypted workspace on a new device N. N
creates an independent protected personal identity for every encrypted workspace its
account lists, and submits one account-scoped join request. It carries N's display
name, a fresh request ID, an expiry and, per workspace, the genesis, N's signing and
encryption public keys, possession proof and credential hash. The request also carries
a commitment `H(nN)` to a 32-byte random value. No pairing code is exchanged. N then
shows a waiting screen listing the account's approved personal devices.

**Relay and notification.** The service relays the immutable request to every approved
personal device of the same account and pushes a pending event to them. It never holds
keys, never signs, and cannot approve. It attaches its own observed approximate
location and request time, both unauthenticated. The request expires (proposed: 10
minutes) and any approver may decline it.

**Short authentication string.** An approver device A that opens the request contributes
its own random `nA`, signed with its key. N then reveals `nN`. Both compute a 6-digit
decimal code from `nA`, `nN`, A's signing key, the account and the complete list of
`(genesis, N keys)`. The code appears on both screens. The commitment fixes N's inputs
before A's value is known, so a substituted request gets a single 1-in-10⁶ guess
per attempt and cannot be ground offline. A shows the device name, location, request time
and code, and signs only after the user confirms that the codes match. A second
approver runs its own exchange and code.

**Approval covers the account.** One confirmation authorizes every workspace in which
A is an active personal device of the same user's membership; all are selected by default
and the user may deselect any. For each selected workspace, A verifies N's possession
proof against its own pinned genesis and appends the existing personal `AdmitDevice`
record. No new ledger operation is introduced. A then publishes a signed snapshot
invitation, so N pins genesis and A's endorsement key from evidence that the confirmed
code authenticated. Current and historical keys use the existing mailbox and history
paths. Workspaces A cannot sign for stay pending for another approver.

**Progress and failure.** A journals each workspace's exact signed admission before any
network step. It resumes per workspace, retries the original bytes and reconciles
unknown outcomes; it never re-signs. Ledgers are independent, so there is no
cross-workspace atomicity. Each workspace is either admitted with its key delivered,
admitted and awaiting delivery, or not admitted. N advances automatically as admissions
and keys arrive and opens the conversation once the current key is installed. An
expired, declined or unconfirmed request admits nothing. Revocation and removal
semantics are unchanged. Ledger details move to an advanced diagnostics view.

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
- **Format.** The retained encoding is current-format only and versioned: retained envelope version 4, snapshot body version 4 and the `snapshot-digest/v4` digest domain (version 1 was the pre-compact layout). Any other version fails with `unknown-version`; the party then discards its retained state and rebuilds it by one full replay of v1 history. Changing the encoding bumps these versions.
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
[stage-before-CAS](e2ee/publisher-key-recoverability.md). This Spec revision is approved as recorded above; boundary approval
and executed synthetic tests do not establish native custody acceptance.

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
updates bootstraps through actual Loro/Flock consumers. This revision
is approved as recorded above; approval does not enable product encryption.

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
