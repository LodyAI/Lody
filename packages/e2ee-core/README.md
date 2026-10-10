# E2EE foundations

An independently testable extraction, with no production consumers. The only
package entry is `@lody/e2ee-core`; it uses the root Effect 4.0.2 catalog.

| Entry | Responsibility |
| --- | --- |
| `Bytes` | Copy-owning public keys, hashes, IDs, signatures and opaque epoch secrets |
| `encodeCbor` / `decodeCbor` | Bounded canonical array/scalar CBOR; no ledger schemas |
| Context/header/AAD/signing-byte encoders | Existing content v0 byte domains, document generation zero |
| `inspectContentFrame` | Unverified routing metadata only |
| `verifySignature` | Strict Ed25519 Result; no signing or private-key input |
| `verifyContentSignature` | v0 signature against caller-supplied scope and trusted signer |

Use `Effect.fromResult` in existing workflows; this package starts no runtime.
CBOR encoding budgets the expanded wire size before serialization and copies only
bounded data. Shared values remain valid within 8192 bytes; cycles return a Result
failure. These limits bound data traversal, not arbitrary code in getters/proxies.
`verifyContentSignature(frame, trustedScope, trustedSigner, additionalData?)`
checks the supplied organization genesis, document resource, epoch, purpose and
independent binding. It does not decrypt, establish membership, approve a
snapshot, or grant publication permission. A valid signature can cover invalid
ciphertext. `contentKeyInfo` returns derivation context, not derived key material.

P14 can consume `Bytes.SigningPublicKey`, `Bytes.EncryptionPublicKey`,
`Bytes.Signature` and the validators from this root entry. Private keys and native
handles stay in the platform owner. `EncryptionPublicKey` preserves the candidate's
32-byte, nonzero wire-shape check; it is not proof of safe X25519 agreement or
possession. Do not use it as one. No generic signer or key export is introduced.
AEAD, actual HKDF derivation, HPKE and scoped document-key custody remain future
slices; no SDK or repo 0.22 dependency is needed here.

Source files and exact input SHA-256 values are in [provenance.json](provenance.json).
Extraction omits ledger/snapshot schemas, trust caches, injected executors,
content encryption/decryption and host adapters. The HKDF salt is returned as a
fresh copy instead of shared mutable bytes. Protocol bytes remain unchanged.

Run `pnpm --filter @lody/e2ee-core typecheck` and
`pnpm --filter @lody/e2ee-core test`. Tests include the
[RFC 8032 §7.1 vector](https://www.rfc-editor.org/rfc/rfc8032#section-7.1).
`test/content-vector.json` is a synthetic v0 frame signed independently with
Node's native Ed25519 and the RFC test seed: genesis `11` repeated 32 times,
epoch `0x01020304`, resource `doc`, purpose 1, nonce `22` repeated 24 times,
opaque ciphertext/tag `33` repeated 16 times, optional binding `abcd`.
This fixture tests signatures, not AEAD. Both frames are fixed and native-checked.

See the [Spec](../../specs/e2ee-foundations.md) and
[extraction decision](../../.agents/notes/implemented/architecture/2026-10-10-e2ee-foundations.md)
for trust boundaries, failure ownership and validation limits.
