# Compact E2EE content packets v2

Status: draft
Translation: current

[中文](./e2ee-content.zh.md)

A document sends one encrypted batch, even when that batch contains several CRDT
updates. Org and document context already belong to the caller. Repeating those
IDs and claimed author identities inside every packet wastes space and creates
identity claims that a snapshot-only reader cannot substantiate.

## Format and trusted context

All new content writes use v2. Multibyte integers are unsigned big-endian; keys,
nonces, ciphertext and signatures are raw bytes. The enclosing SDK or blob storage
provides the complete packet boundary; no inner total-length field is needed.

```text
packet = version(1, value 2) || epoch(u32be) || signerPublicKey(32)
       || nonce(24) || sealed(plaintext.length + 16) || signature(64)
prefix = version || epoch || signerPublicKey
unsigned = prefix || nonce || sealed
```

`sealed` is XChaCha20-Poly1305 ciphertext followed by its single 16-byte tag.
Ed25519 signatures use strict canonical prime-subgroup validation. Payload length
is 0..16 MiB; complete packet length is 141..16 MiB+141 bytes. Unknown versions,
invalid public keys, truncation and over-limit inputs fail without plaintext
fallback. Epoch is 0..2³²−1, matching the ledger epoch contract.

The caller independently supplies the expected genesis, logical document/resource
ID and purpose. Genesis is the Org identity, not an additional Org ID. Transport
URLs are routing, never resource identity. `inspectContent` returns only unverified
`{version, epoch, device}`; `device` is the hex presentation of signerPublicKey for
local APIs. The epoch selects a key only from a locally verified keyring.
`authenticate(scope, frame)` also requires trusted scope, even without decryption.

The canonical binary context `C` is:

```text
C = genesis(raw 32) || epoch(u32be) || resourceLength(u16be)
  || resource(1..1024 printable non-whitespace ASCII bytes) || purposeCode(u8)
```

Purpose codes 1..9 respectively mean `doc-update`, `doc-snapshot`, `flock-update`,
`flock-snapshot`, `blob`, `epoch-history`, `presence`, `rpc-request`, `rpc-response`.
No Unicode normalization, aliases or JSON number/string conversion is involved.
All domains below are literal ASCII including the trailing zero byte:

```text
key = HKDF-SHA-256(epochKey,
  salt="lody-content-hkdf/v2\0", info="lody-content-key/v2\0" || C, length=32)
AAD = "lody-content-aad/v2\0" || C || prefix
signatureInput = "lody-content-signature/v2\0" || C || unsigned
```

For optional nonempty external `additionalData` (1..1024 bytes), use separate
binding domains and an explicit length. Omitted or empty data retains the generic
v2 formulas above. The external bytes and this length are authentication inputs,
not transmitted content fields:

```text
B = u16be(additionalData.length) || additionalData
AAD = "lody-content-aad-bound/v2\0" || C || B || prefix
signatureInput = "lody-content-signature-bound/v2\0" || C || B || unsigned
```

Both seal and open/authenticate capture the independent bytes before async work.
Missing or changed binding fails the signature. Re-signing unchanged ciphertext
with a different binding still fails AEAD. External AAD does not affect HKDF or
add packet bytes.

The receiver constructs C from its own expected context, never from a received
header. Wrong Org, document or purpose fails signature verification; a genuine
signer re-signing unchanged ciphertext for another context still fails AEAD.

## Authorship and permission

The packet key is only a lookup candidate. `ContentPolicy` must accept keys solely
through the specified Org's verified ledger. `contentAuthorKey` checks that Org
and current or historically admitted device evidence. Async crypto is followed by
an authority consistency check. Possessing an epoch key grants neither publication
nor command execution permission. Guest and R cannot seal new document content;
current personal/machine write permission and the rotation gate remain separate
from historical signature verification. Legitimate old epochs remain readable.

`Ledger.contentIdentity` and `LedgerView.contentIdentity` derive the original
user/member instance from an index built only during verified replay. The index
survives revocation/removal and is rebuilt when restoring the stored verified
history; signing keys cannot be enrolled again under a new membership. It is not
added to ledger wire or snapshot wire. An endorsed snapshot recovers mappings for
its active devices; a removed historical device present only in replay-prevention
facts returns `device-only` with `missing-history-context`. This preserves existing
historical verification semantics without inventing a complete author identity.
Full verified history is needed for that missing attribution.

Local `SealContent.author.actor/memberInstance` fields remain caller metadata for
existing adapters; they are neither encoded nor used as identity evidence. A batch
signature identifies the batch/snapshot producer, not every original CRDT operation
creator. There is no messageId or new durable command replay scheme.

## SDK and host responsibilities

SDK `provider.open` returns the unchanged original batch/snapshot bytes. The
provider passes exact SDK AAD as external `additionalData` to both AEAD and signing,
without copying it into plaintext. SDK AAD is the literal 40-byte domain
`loro-streams-crdt-payload-protection/v2\0` followed by the authenticated 10-byte
LSCE prefix and one-byte provider header (51B total). The host reconstructs these
bytes from its structurally validated envelope for independent signature checking.
Provider headers are `3` for updates and `4` for snapshots; former `1`/`2` AAD-copy
headers are rejected. SDK envelope version remains 2, content version remains 2.
Update plaintext is exactly the SDK batch; snapshot plaintext retains
`u16be(offsetUtf8.length) || offsetUtf8 || originalSnapshot`, with a 1..1024-byte
UTF-8 offset, checked against the receiver's continuationOffset. The SDK wraps the
one-byte header and complete content packet; that overhead is separate from 141B.
An update POST body is `4B item length + 10B SDK prefix + 1B provider header +
141B content overhead + batch`, or `batch + 156B`. Batch framing adds 4B per raw
update. Removing `2B aad length + 51B aad` saves 53B per encrypted batch; this is
encoded body length, excluding HTTP/TLS. The host supplies expected
Org, document and snapshot purpose independently and binds authenticated submitter
to signing device. Its original lease, current write check, idempotent exact retries
and atomic publication store are unchanged. Readers authenticate the snapshot
continuation position. Documents are persisted before durable cursors; failed
persistence must leave the old cursor usable for replay.

Each Effect execution owns erasable working copies. Derived keys use Effect
resource finalizers, including failures and interruption; a JavaScript generator
`finally` is insufficient for typed Effect failure. Captured immutable inputs allow
repeat/concurrent/retry executions. This does not promise erasure of every hidden
WebCrypto or JavaScript runtime copy.

## Compatibility and integration boundary

This experimental private package has no product content stream activation. The
source checkouts contain no persistent content DB/repro fixture; Lab defaults use
separate temporary directories, and `--data-dir` and saved repro packs can retain
v1 bytes outside the checkout. Those external directories were not exhaustively
inventoried. No claim is made that all old data is absent.

Optimized SDK readers also reject the earlier experimental v2 provider headers
1/2. Generic v2 content without external AAD remains compatible. Retain any old
v2 SDK experiment with its exact pre-optimization reader/source and use a new
stream/data directory for the new binding revision; no silent fallback or
migration is included. This does not claim all external retained data is absent.

v2 readers reject v1. Retain old experiments with the v1 reader pinned at
`35bfca7e`; start v2 Lab work in a new directory. For retained data, an explicit
migration must first verify/decrypt with the pinned v1 implementation and independent
scope, then publish a new v2 snapshot as its actual producer to a separately staged
stream. Preserve original signed bytes for audit; never silently re-sign another
person's update or rewrite original attribution. No automatic migration is included.
Ledger records, epoch envelopes, independent 72B history packets and key delivery
receipts keep their formats. The legacy control-log's optional content-frame-based
history helper now follows v2 and shares this compatibility limit.

Existing content consumers are the SDK/provider, snapshot publication, Lab host,
Lab content sessions and the attack-only insider reader; all pass independent
scope. Generic blob/presence/RPC purposes are covered by codec roundtrips and
cross-purpose rejection. Full product attachment/presence/RPC and production
gateway wiring are still absent, not enabled by this format change. Published
streams-crdt 0.15.1 still lacks snapshot continuationOffset; core HTTP snapshot
checks use the existing `LORO_STREAMS_CRDT` source override. Lab uses its existing
vendored SDK. No deployment or formal security proof is claimed.

This spec replaces the old content-header/authorship descriptions in the
[legacy control-log spec](./e2ee-control-log.zh.md#内容信封实验版) and the content-author
bullet in the [ledger spec](./e2ee-ledger.zh.md); their independent ledger/recovery
formats remain outside this decision.

## Evidence

- [Decision and measurements](../.agents/notes/implemented/architecture/2026-10-09-e2ee-content-v2.md).
- [Codec and crypto](../packages/e2ee-core/src/pure/content-frame.ts), [workflows](../packages/e2ee-core/src/workflows/content.ts).
- [Content tests](../packages/e2ee-core/test/content.test.ts), [SDK/persistence tests](../packages/e2ee-core/test/streams-content.test.ts), [history attribution](../packages/e2ee-core/test/ledger-content.test.ts), [Lab authority](../packages/e2ee-lab/test/content-authority.test.ts).
- [XChaCha combined-mode tag](https://doc.libsodium.org/secret-key_cryptography/aead/chacha20-poly1305/xchacha20-poly1305_construction), [HKDF context](https://www.rfc-editor.org/rfc/rfc5869).
