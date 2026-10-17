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

## Format compatibility

**Freeze point.** Ledger v1 (record version 1, the `sig/v1` and `rec/v1` domains and the operation codes in the [permission-ledger Spec](e2ee/permission-ledger.zh.md)) becomes permanent when a production deployment first enables encrypted workspace creation, because only then can a ledger exist that must never break. Merging code does not freeze it. Until that point the format may still change, but only with owner approval, and the same change regenerates `packages/e2ee-core/test/ledger-v1-vector.json` with its independent generator; development and staging ledgers created earlier may stop verifying. Production creation must not be enabled before a format review confirms that the record shapes, operation codes, signing domains and the open items in permission-ledger §9 (recovery vault and trust-anchor encoding, rotation after self-revocation, recovery-device enrollment order) need no change to how existing records encode or verify. After the freeze the vector is never regenerated.

**What freezes.** Every record that v1 accepts at a position must stay accepted by every later client, with the same bytes, hashes and resulting ledger state. New behavior, including relaxed or extended permissions, takes effect only through records after a capability declaration; it never changes how an existing record verifies.

Ledger evolution is append-only:

- A new operation becomes valid only after a capability declaration (operation tag 9) earlier in the same ledger. The declaration lists strictly ascending nonzero u32 capability codes, is signed by an Owner or Admin personal device and is monotonic. A client that does not implement a declared capability verifies the preceding records and stops at the declaration with `upgrade-required`; it never reports corruption or skips the record. Writers and hosts refuse a declaration they do not implement and any operation whose capability was not declared earlier.
- Changing the cipher suite or another genesis-level parameter creates a new ledger with a new genesis. The old ledger is never rewritten; it ends with a link record introduced through a capability, as MLS ReInit links a replacement group.

Every other format remains current-only. Content, journal, local-store and snapshot formats have no deployed data: support only the current format for each entrypoint, with no old-format decoders, dual readers, schema upgrades, legacy imports or compatibility facades. Snapshots can always be rebuilt from full v1 history, so a snapshot format change does not break ledger compatibility. Unsupported formats fail without rewriting their input. Normal reopening of current stores, verified history within the current ledger and epoch-key history recovery remain required. This scope choice does not select any pending replacement format or approve production activation.

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
