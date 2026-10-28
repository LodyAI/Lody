# Encrypted attachment keys and opaque relay parts

Status: proposed
Translation: current

[中文](2026-10-28-encrypted-attachments.zh.md)

## Abstract

Encrypted workspaces need files and images without a plaintext upload path. Each upload uses a random file key and bounded authenticated parts; its secret manifest travels only inside encrypted conversation content. This keeps historical attachments readable after epoch changes without modifying the control ledger. The implementation is under review; backend deployment and packaged device acceptance are separate. Existing relay retention still applies, and downloaded plaintext or keys cannot be recalled.

## Decision

A fresh 256-bit AES-GCM key belongs to one upload attempt. A 4 MiB plaintext part becomes one opaque relay object, including its 128-bit tag. Its 96-bit IV is eight zero bytes followed by its zero-based 32-bit part index; the unique per-file key prevents nonce reuse across uploads. Failed attempts never reuse a key. The authenticated data is the JSON UTF-8 tuple of domain `lody-encrypted-attachment-v1`, expected workspace, source session, random resource ID, kind, total size, original name, MIME, fixed chunk size and index.

The version-one manifest holds key, resource ID, kind, size, original name, MIME and ordered part IDs. The encrypted and signed conversation content authenticates this manifest; each part authenticates its position and full-file context. Readers reject wrong context, wrong order, duplicate or missing references, modified bytes and unexpected lengths before exposing that part. File materialization verifies the plaintext hash and renames a private temporary file only after the complete download succeeds. Preview reads can authenticate only their bounded prefix.

File keys are independent of epoch keys. Retaining a conversation's historical decryption ability retains its file keys; rotation does not require reuploading files. An epoch-derived key would require retained epoch-key selection on every attachment read and a new native crypto operation. Per-file keys reuse the protected conversation boundary and keep epoch secrets in host custody. The manifest is secret; it must never appear in relay metadata, URLs, grants or diagnostics.

## Ownership and failure recovery

The existing pending-send owner retains source Blobs after failure, reuses complete successful attachment receipts, and commits the message only after all attachments are ready. Parts from a failed file attempt can remain unreferenced until ordinary relay expiry; failed image attempts retain the image store lifetime; avoiding them would require a durable upload inventory and garbage-collection protocol. In-memory unprepared drafts retain their existing page-lifetime limit.

Local file backfill persists the complete encryption manifest with the relay receipt before publishing the history reference. Restart reuses that exact receipt; a corrupt or unprotected encrypted receipt refuses adoption while preserving the local source. Ordinary backfill tolerance remains unchanged. Native save shares a file only after authenticated streaming finishes, deleting a partial cache file on error. Existing send-resource cancellation and backfill authorization generations retain ownership; these Promise/Legacy consumers are not a complete native Effect migration unit.

## Cloud boundary and trade-offs

The optional cloud protocol adds attachment-only access to the existing device-authenticated content-token response. The dedicated encrypted-file route rechecks live device/member eligibility and workspace scope on every request, with Guests restricted to reads. Recovery devices and legacy credentials cannot use it. A request already admitted may finish during revocation; a downloaded file or key remains available locally. The token has at most a fifteen-minute lifetime and is not a device credential or encryption key.

The relay receives only opaque part IDs, a fixed binary name, generic MIME, ciphertext length and ciphertext hash. Image thumbnails and file previews decrypt on the client; no server image transformation is used. File parts retain the existing file bucket and 90-day expiry. Image parts use their own encrypted-image route and the existing image bucket lifetime; account erasure inventories both. A 100 MiB file needs at most 25 requests. Ordinary workspaces keep their existing image/file paths. Public local-only composition still has no authenticated cloud capability.

This partially supersedes the attachment restriction in the [feature-availability decision](../../implemented/bug-fix/2026-10-27-e2ee-feature-availability.md); its other unavailable-feature rules remain independent.

## Verification limits

`packages/shared/tests/encrypted-attachment.test.ts` covers crypto context, tamper, order, length, retry and history conversion. Existing attachment preparation, image cache, CLI input/image download and backfill suites cover their consuming boundaries. Synthetic tests do not establish deployed authorization, physical mobile save or two installed desktop devices.
