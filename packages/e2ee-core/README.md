# E2EE foundations

An independently testable extraction, with no production consumers. The root
foundation entry is `@lody/e2ee-core`; it uses the root Effect 4.0.2 catalog.

| Entry | Responsibility |
| --- | --- |
| `Bytes` | Copy-owning public keys, hashes, IDs, signatures and opaque epoch secrets |
| `encodeCbor` / `decodeCbor` | Bounded canonical array/scalar CBOR; no ledger schemas |
| Context/header/AAD/signing-byte encoders | Existing content v0 byte domains, document generation zero |
| `inspectContentFrame` | Unverified routing metadata only |
| `verifySignature` | Strict Ed25519 Result; no signing or private-key input |
| `verifyContentSignature` | v0 signature against caller-supplied scope and trusted signer |
| `deriveContentKey` | HKDF-SHA-256 scoped opaque leaf from `Bytes.EpochKey` |
| `sealContentAead` / `openContentAead` | Content v0 XChaCha20-Poly1305 primitive; separate signature/authority checks required |
| `epochHpkeAad` / `sealEpochKeyHpke` / `openEpochKeyHpke` | Fixed Base epoch HPKE primitive; no sender authentication, authority or installation |

Compose HPKE Effects directly and use `Effect.fromResult` for Result primitives
in existing workflows; this package starts no runtime.
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
Full signed HPKE delivery, document-key import/export and signed content workflows
remain future slices; no SDK or repo dependency is needed here.

Source files and exact input SHA-256 values are in [provenance.json](provenance.json).
Extraction omits ledger/snapshot schemas, trust caches, injected executors,
full signed content workflows and host adapters. The HKDF salt is returned as a
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

## Content AEAD primitive (P07-b)

`deriveContentKey(epochKey, trustedScope)` consumes an opaque `Bytes.EpochKey`.
The returned opaque key owns its bytes and derivation context; it has no public
constructor or export. Four document purposes share a derived leaf. Other purposes
have independent leaves. Every seal/open checks the derivation context and binds
the exact purpose, trusted signing device, header and optional external data in AAD.
Salt, info, big-endian fields and domains retain candidate content v0 bytes.

`sealContentAead(key, trustedHeader, plaintext, additionalData?)` returns only
`{ nonce, ciphertext }`, where ciphertext includes exactly one 16-byte tag. It
obtains a fresh 24-byte nonce from `globalThis.crypto.getRandomValues`; missing or
throwing randomness returns `content-random-unavailable`. No caller nonce or random
source override is exposed. Retain exact ciphertext for retries. `openContentAead`
accepts that nonce/ciphertext and the independently trusted header; it returns
plaintext only after tag verification. Neither function creates a signed frame,
verifies author authority, or checks permission/freshness. Callers must perform
those checks separately before consuming plaintext or publishing bytes.

Inputs are bounded before large copies: plaintext 0..16 MiB, ciphertext 16..16 MiB
+ 16, nonce exactly 24 bytes, external binding 0..1024 bytes. Scope/header errors
retain the existing content codes; malformed nonce/ciphertext have separate codes,
context-key mismatch is `content-key-scope-mismatch`, tag failure is
`content-authentication-failed`. Errors contain codes only. Temporary epoch-key
copies, HKDF PRK, operation key copies and encryption plaintext copies are wiped
in `finally`; the derived key lasts while its opaque object is reachable. This is
best-effort JavaScript cleanup, not a guarantee that runtimes erase all copies.

[Fixed synthetic vectors](test/crypto-vector.json) use Python HMAC-SHA256 and
PyNaCl 1.6.2/libsodium with independently encoded v0 bytes. Tests also compare with
native Node/WebCrypto HKDF, cover wrong contexts/keys, tampering, exact limits,
random-source failure and input ownership through the public package entry.
A browser bundle was exercised in Chromium; this is not all-platform acceptance.
See the [extraction note](../../.agents/notes/implemented/architecture/2026-10-11-e2ee-content-crypto.md).

To regenerate the fixture in a disposable Python environment, install `PyNaCl==1.6.2`
and run `python test/generate-crypto-vector.py > test/crypto-vector.json` from this
package. Runtime tests consume the checked-in JSON; Python is not a project dependency.

The separate [`@lody/e2ee-core/ledger`](src/ledger/README.md) subentry now
provides strict records, signature/chain verification and deterministic permission
replay from caller-pinned trust. It has no snapshot, CAS, journal or production
consumer. The root exports and crypto modules remain unchanged. Ledger extraction
fingerprints are [separate](src/ledger/provenance.json).

The [submission subentry](src/submission/README.md) adds finite persistent recovery
for existing-ledger ordinary records, with an explicit Scope-owned SQLite Layer.
It calls P08 replay before CAS and readback, retains exact signed bytes and
unconsumed results across process restart, and exposes no production host or signer.

## HPKE epoch primitive (P07-c)

`epochHpkeAad`, `sealEpochKeyHpke` and `openEpochKeyHpke` preserve the existing
ledger envelope's Base suite: DHKEM(X25519, HKDF-SHA-256), HKDF-SHA-256 and
ChaCha20-Poly1305 (RFC identifiers 0x0020/0x0001/0x0003). Info is exactly
`lody-e2ee/hpke-epoch/v1\0`, including the final zero byte. AAD is canonical
DAG-CBOR `[genesis32, epoch(u32), senderSign32, recipientSign32]`, supplied from
independently trusted caller context. Plaintext is one opaque 32-byte EpochKey;
output is `enc32` and `ct48`. The existing full envelope remains
`AAD || enc32 || ct48 || signature64`, signed over
`lody-e2ee/epoch-env/v1\0 || AAD || enc32 || ct48`. This slice does not construct,
sign, authenticate, deliver or install that full envelope.

The functions return Effect values with fixed, non-secret errors. Execute them in
the caller's existing Effect owner. Every new seal gets 32 bytes of host secure
randomness for DHKEM derivation, with no public entropy override or retry fallback.
Opening requires a caller-owned X25519 CryptoKeyPair and its independently trusted
expected encryption public key. No private-key generation/export/store is added.
Temporary plaintext and random copies are wiped after native work settles;
interruption waits for that cleanup because WebCrypto has no abort API. This is
not a bounded shutdown guarantee if the host's native crypto never settles, nor
complete erasure of library/native-runtime internal copies.

Base decryption **does not authenticate a sender or grant authority**. Callers must
verify the outer signature, current sending/receiving eligibility, recipient key
binding and epoch-key commitment before using or durably installing the result,
and recheck authority after async operations. Those workflows remain separate.
The primitive exposes no transport, ledger shortcut, recovery format or production
switch. [HPKE tests](test/hpke.test.ts) cover independently encoded RFC/Python
vectors, trusted-context mismatch, lengths, randomness failure and interruption.
