# Ledger-bound signed documents

Document content (exported through `@lody/e2ee-core/protocol`; the Streams binding through `@lody/e2ee-core/adapters/loro-streams`, host admission through `@lody/e2ee-core/host`) implements the settled Loro/Flock update/snapshot workflow.
It preserves content v0 wire bytes, purpose domains, scoped document HKDF and
XChaCha20-Poly1305. The four document purposes share a leaf but have distinct
signature/AAD contexts.

`deriveDocumentKey(scope, epochKey)`, `importDocumentKey(scope, bytes)` and
`exportDocumentKey(key)` are synchronous Result functions. A document leaf is
registered in a private WeakMap and bound to genesis/resource/epoch/docEpoch=0;
clones cannot create keys. Import/export own copies and grant no authority.
The supplied epoch key/document leaf must come from the caller's validated local
installation; derivation alone does not verify an epoch commitment. `scopedDocumentKey` derives lazily and releases its independently owned leaf with Scope.
`disposeDocumentKey` is idempotent and invalidates only that leaf, leaving borrowed
epoch keys and independent siblings intact. Owned byte buffers are cleared; this
is not native secure custody or guaranteed physical-memory erasure. Device private keys cannot be exported here.

`sealDocument` returns an inert Effect. Inputs are read and bounded when it runs;
caller-owned scope, plaintext, binding, signer and lookup capabilities are captured
before the first async lookup. The scoped plaintext scratch is wiped after sealing
and on failure/interruption; the caller buffer remains theirs.
The caller supplies a borrowed DeviceSigner and a synchronized verified-view
lookup. Each view must be genuine full replay or explicitly qualified endorsed
state, with its provenance preserved. Later lookups must extend the first verified
prefix; known rollback/forks fail. Sealing binds
the caller's genesis, resource, purpose and current epoch; active non-Guest
personal/machine devices may seal only when rotation is not required. It checks
before encryption and after asynchronous signing, and always verifies signer
output with the fixed strict verifier. No injected verifier/authority can accept
unsigned content. Each run is a new encryption; a transport retry must retain the
returned bytes, rather than rerun encryption. No pending store is introduced.

`authenticateDocument` returns only historical author/signature evidence relative
to that verified view and caller scope. It authenticates revoked admitted authors;
the returned author is `kind: member` with the original actor/membership, from
full history, an endorsed snapshot or retained state alike, since all carry the
device history. No new write right is restored. This does not establish current publication permission, ciphertext validity, global
freshness or prior host admission. `openDocument` additionally verifies the AEAD
and returns an owned plaintext buffer. Untrusted metadata cannot choose the
trusted genesis/resource/purpose. Context, signature or tag failure returns no
plaintext and never falls back to ordinary bytes. The consumer owns plaintext
cleanup after use. Host admission must independently enforce current permissions.

`@lody/e2ee-core/protocol` also exposes a borrowed `DeviceSigner`, `signVerified` and
`nativeDeviceSigner`. The native adapter borrows an existing Ed25519 CryptoKey,
creates no identity and starts no runtime. It awaits non-cancellable WebCrypto
settlement and wipes message scratch on success/failure before interruption
completes. The owner retains the handle's lifecycle; cancellable custom signers
must implement cancellation in their Effects. The factory validates key shape;
`signVerified` proves the signature matches its expected public key, not ledger
permission. Neither performs platform-specific secure storage.

Non-document generic content, published-SDK protection/admission, recovery and Lab
composition remain separate migration owners. Canonical epoch history and ordinary
ledger signing now have their own public subentries. Presence/RPC machine-operation scope requires its
own decision. This module does not enable product E2EE or publish a package.

`realtime.ts` composes the existing v0 cryptography with fixed purpose 7/8/9
entrypoints. It is a primitive beside the ledger-bound document workflow, not a
machine-operation authorization workflow. It accepts an independently supplied
resource and expected signer, with opaque application bytes; it selects no RPC
body encoding, room/target prefix, new limit or clock policy. Seal inputs are
captured at Effect execution before signing, derived leaves and plaintext scratch
are released on every exit, and borrowed epoch/signer capabilities stay with their
owner. Open verifies the exact expected signer and context before deriving a key
or decrypting. A successful open returns caller-owned plaintext, not permission.
The caller must still check body semantics, target binding, request correlation,
TTL/freshness, membership, epoch/rotation pause and journal requirements.

Run package `typecheck` and `test`. The owning crypto suite uses fixed synthetic
Node/native WebCrypto signatures, real HKDF/AEAD and explicit Deferred/native
interruption signals. Crypto completion gating is a stated test boundary; no
sleeps, real keys or physical-device claims are involved.

[Trust decisions](../../../../../.agents/notes/implemented/architecture/2026-10-15-e2ee-current-decisions.md#trust-and-authority)
· [Source fingerprints](https://github.com/LodyAI/Lody/blob/5f97599e60700d6185834632df85922ea0d73ec6/packages/e2ee-core/src/content/provenance.json).

`makeStreamsUpdateBinding` (and its services-based form `streamsDocumentBinding`) is an Effect-native header3 update
and header4 snapshot codec, consumed by released streams-crdt at the current catalog version in the Lab. Its initialization Scope closes
admission, awaits active operations and rejects late output. The independently
selected Org/resource/model and fixed signer are captured once. A numeric
`writeEpoch` remains fixed; explicit `writeEpoch: 'current'` selects the genuine
current epoch for each seal, then binds that operation through its final authority
check. A change during signing fails instead of silently re-encrypting. Each
key read must transfer a fresh owned opaque epoch key; the codec verifies its real
ledger commitment before deriving a scoped leaf and clears both after use.
Historical signatures are checked before untrusted frame epochs can request keys.
Content snapshots also require a current non-Guest personal/machine writer before
key lookup and after decryption. Snapshot opens reuse their owned authenticated
frame for AEAD and recheck current permission against a genuine extending ledger;
they do not repeat signature verification on unchanged bytes. Historical update
reads retain their previous verification path. The product's native-snapshot MVP
and replay/trim recovery policy are recorded in the
[PR-17 note](../../../../../.agents/notes/proposed/architecture/2026-10-27-e2ee-native-content-snapshots.md).
It contains no Promise runner, production protector or SDK transport. Lab owns the
actual SDK bridge, plaintext disposal after use and transport/native lifetime.
The sole snapshot provider header is `[4]`. Snapshot content v0 inserts a u16be
length and raw ASCII continuationOffset immediately after the signing public key;
the complete header participates in signature and AEAD. Readers compare the exact
SDK continuation after authenticating/decrypting, so a transplanted snapshot fails
without durable advancement. Updates retain their unchanged header3 and 143B
content overhead; snapshots add 2 + offset bytes. The generic u16 limit is65535;
the released SDK's4096B maximum sealing overhead limits its adapter to3950 ASCII
bytes. Unsupported provider/header encodings have no compatibility reader.
The user selected v0 over v2; sharing one document leaf supports future per-document
grants, while purpose-bound AAD/signatures prevent cross-purpose substitution.
See the revised [draft Spec](../../../../../specs/e2ee-foundations.md).

Host consumers use `admitDocument` to upload already sealed originals. The genuine
current view must grant `mayWriteDocument` to the externally authenticated signing
device, and the frame epoch must have a verified history packet and be no later
than that view's current epoch. A required rotation or a later tag7/tag8 publication
does not invalidate an active writer's earlier sealed bytes. New `sealDocument`
and streams-binding seals instead require `maySealNewContent` and the exact
current epoch, before encryption and again after asynchronous signing. Revoked,
removed, Guest or Recovery writers still cannot upload; historical
`authenticateDocument` remains separate and grants no upload permission.
`admitStreamsUpdateBatch` checks released streams-crdt at the current catalog version framing and header3,
rejecting the entire batch if any frame is invalid before the host forwards
unchanged original bytes. A batch may contain valid frames from different
published epochs; retries never reseal an older frame.
`admitStreamsSnapshot` and its Effect form check the released kind2 envelope,
fixed provider header4 and position-bound content frame, exact authenticated submitting device and current
write permission and a verified published epoch no later than the current one.
Both admission paths recheck after native work at the host.
They do not decrypt or prove ciphertext usability; readers still verify AEAD.

`makeSqliteSnapshotPublication` (`@lody/e2ee-core/adapters/node-sqlite`) is the single-host reference publication journal.
It binds one Org/resource/model and retains immutable offset/signer/SHA-256 identities,
uncertain Pending attempts, Accepted receipts and a current pointer. Only current
and Pending rows retain ciphertext bodies. Accepting a new current clears older
Accepted bodies in the same transaction, retaining their first credential window
and digest. Capacity counts retained bodies, not archived identities. Each lookup
reads metadata and its selected row; there is no in-memory history or full-table
audit on each operation. Different bytes at an existing position conflict. Accepted original retries perform no PUT
or pointer write; native HEAD/tail selection is external, never opaque-offset
arithmetic. The gateway reserves and reads the original before native PUT, then
compares actual readback before accepting. Uncertain outcomes remain Pending and
block new snapshots; `resumeSnapshot` only confirms exact native readback. This is
an explicit host recovery capability, not transparent SDK re-encryption/retry.

The one resource/model gateway must own serialized native writes through actual
settlement before another owner opens the same journal. It does not provide
multi-host fencing or a transaction across Riverrun and SQLite. Historical
signature verification still authenticates an exact Accepted retry; new writes
need current permission and the first persisted credential window. A fresh token
cannot extend an unconfirmed attempt. Exact native bytes can be confirmed later
without another PUT. The fixed database
contains ciphertext/public identity only and supplies no ledger authority.

The host also supplies an actual `snapshotBoundary` capability. It must prove the
opaque offset exists at a native record boundary no later than head; neither string
ordering nor an SDK HEAD echo proves this. The Lab's read-only Riverrun adapter
checks actual row boundaries. Boundary validation is additional to signature/current
permission; it never establishes independent snapshot trust.
