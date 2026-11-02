# Purpose-specific realtime content primitives

Status: proposed
Translation: current

[中文](2026-10-26-e2ee-realtime-content-primitives.zh.md)

## Abstract

Realtime integration needs separate presence, request and response encryption without widening document signing authority. This change composes the existing content-v0 format into six purpose-specific APIs over opaque bytes. It owns temporary plaintext and derived keys, checks the independently trusted signer before decryption, and preserves the document workflow boundary. This is a reviewable cryptographic subset of M5 PR 25; application wire encoding, target-machine authority, permission freshness and product integration remain unapproved or unfinished.

## Responsibility and alternatives

`@lody/e2ee-core/protocol` exposes paired seal/open APIs for existing purposes 7, 8 and 9. They reuse `deriveContentKey`, content-v0 AEAD, strict Ed25519 and existing content bounds. The caller supplies the trusted genesis, epoch and resource, an installed opaque epoch key, and a signer or independently expected signing public key. No resource-prefix convention, body codec, request identity, deadline or room TTL is selected here.

Reusing `sealDocument` would incorrectly broaden a ledger-authorized document operation. A generic public signing/encryption API would also expose more authority than needed. Instead, each public function fixes one existing purpose while sharing a private implementation. A successful open proves only cryptographic authenticity under the supplied scope and signer; it grants no permission or execution authority.

The existing [service architecture](../../implemented/architecture/2026-10-16-e2ee-core-service-architecture.md) remains authoritative for module boundaries. The candidate semantic contract in [25S](https://github.com/LodyAI/Lody/pull/1894) and storage-only journal in [26a](https://github.com/LodyAI/Lody/pull/1895) are independent reviews, not approved integration prerequisites. This change does not approve either proposal, change membership/device management, export private keys, or enable a transport.

## Ownership and failure behavior

Sealing is inert until its Effect runs. It captures mutable inputs before asynchronous signing, borrows the epoch key and signer, and wipes its plaintext copy and derived leaf key on success, failure or interruption. The existing uninterruptible native-signing boundary settles before those buffers are released. Opening checks scope and strict signer identity before deriving/decrypting, disposes the derived key on authentication failure, and returns plaintext for the caller to wipe. Borrowed epoch keys remain usable after local failures.

Callers must retain exact returned frames for retry, independently establish current epoch/rotation gates, and supply the original target's verified signer for responses. Holding the same epoch key does not permit another device to satisfy that signer requirement. Application request correlation and progress/final/error classification still require the reviewed wire contract.

## Evidence and limits

Six fixed full-frame vectors cover purposes 7/8/9 with and without existing additional-data binding. A standalone Python generator uses RFC 5869 HMAC and PyNaCl 1.6.2, independently of the TypeScript implementation, with a public RFC 8032 seed and synthetic plaintext. Regeneration is a review action; it does not change the frozen ledger-v1 vector.

Behavioral tests cover scope/purpose/epoch/target/signer substitution, signed ciphertext with the wrong AEAD context, bounds before copying, mutable-input capture, signer/random failures, cleanup, recovery and native-signing interruption. There is no product RPC, presence, iroh, packaged-platform or latency acceptance in this subset. The full M5 capability remains incomplete.
