# Recovery vault

Status: draft
Translation: current

[中文](recovery-vault.zh.md)

## Approved format boundaries

On 2026-10-28, owner Zixuan Chen (zxch3n) approved only these boundaries, recorded in the [approval note](../../.agents/notes/implemented/architecture/2026-10-28-e2ee-spec-approval.md) ([approval update #2032](https://github.com/LodyAI/Lody/pull/2032)). Recovery admission keeps the existing ledger tag 4 and `lody-e2ee/possess/v2\0` bytes; genesis is unchanged. The encrypted recovery package uses `formatVersion: 1` and contains the recovery generation and trusted ledger material; the trust anchor must be independently confirmed. An encrypted package, its source locator or a server response alone does not establish that anchor or prove the latest ledger head.

Before recovery is accepted, import R's keys, independently confirm the trust anchor, actually decrypt a current-epoch envelope addressed to R and verify the recovered key against its ledger commitment. The R signature binds the encryption public key but alone does not prove possession of its private key. The package version and these boundaries are approved; the remaining vault design and this Spec as a whole remain **draft**, and the recovery vault is outside the MVP. The core package carries `formatVersion: 1` and rejects any other or missing version; its private keys must be the exact 48-byte RFC 8410 PKCS#8 encodings for Ed25519 and X25519 (an implementation detail still awaiting owner review). Approval does not establish deployed or real-device behavior.

## Recovery material and ciphertext

One canonical CBOR `vault-v1` recovery file opens an encrypted vault. Its fixed tuple is
`["vault-v1", 1, vaultId, serviceLocator, U]`: `vaultId` and U are independent random
32-byte values. Generate a separate random 32-byte vault master key V. Derive a
32-byte wrapping key with HKDF-SHA256, salt `vaultId` and the domain
`lody-e2ee/vault-v1/<purpose>\0`; wrap V with XChaCha20-Poly1305. The file is a
vault unlock capability, not a seed from which future workspace identities can be
regenerated. Missing cloud ciphertext cannot be recreated from this file.

A second wrapping entry may wrap the same V only after an authenticated WebAuthn
ceremony actually reports PRF `enabled: true` and a 32-byte `results.first` value.
The portable core validates and owns that result; platform adapters authenticate
the ceremony and credential. Ordinary passkey login and a structural object
claiming to be a verified capability cannot unlock the vault. No PRF fallback is
permitted. No hardware ceremony runs automatically while product E2EE is disabled.

Workspace entries and the index use distinct V-derived purpose keys. Every new
encryption requires a fresh host-secure 24-byte nonce; random-source failure stops
it. Each AEAD AAD binds `vault-v1`, vaultId, opaque entryId, revision, predecessor
ciphertext digest and purpose. The outer service header carries only opaque entryId and revision. A separately
authenticated encrypted header hides purpose and predecessor while the inner
AEAD binds the full AAD tuple; both layers use fresh random nonces and separate
HKDF purpose keys. The service never receives workspace identity, roles or keys. Ciphertext
is immutable under its entryId. A recovery package binds genesis, current
membership instance, independent R signing/encryption key pairs, generation and
the origin of trusted genesis/ledger material. The encrypted index binds the same
workspace/member identity and exact package digest. Import verifies both actual
public/private key pairs. A decrypted claim does not establish ledger authority.

## Concurrency and durable setup

Upload an immutable candidate, read it back exactly and decrypt it before CAS of
the encrypted index. CAS includes the expected revision and ciphertext digest,
plus the opaque entry IDs referenced by the proposed index. The same storage
transaction must verify that every referenced immutable entry exists before it
publishes the index; a missing entry returns Conflict. This prevents a concurrent
delete between the client readback and index CAS from publishing a dangling reference;
the successor binds its predecessor. A client pins its highest observed revision
and digest durably and rejects rollback or same-revision equivocation. Valid
AEAD does not prove freshness: a fresh device still depends on the authenticated
service's fresh read plus independently qualified ledger material.

Concurrent first setup for the same workspace/membership uses the winning
index entry's R. A loser rereads and decrypts the winner; it never registers its
own losing candidate. A disjoint-workspace conflict is an explicit merge/retry,
not last-writer-wins. A different generation of the same identity is a visible
replacement, never a silent overwrite.

Setup consists of four resumable steps, not a cross-store transaction:

1. Generate an independent workspace R and unlock V through the file or verified PRF.
2. Encrypt/upload/read back/decrypt its private package; select it through index CAS.
3. The current active personal device signs the public Recovery admission. Persist
   the original signed record and intended position before P09 dispatch; reconcile
   unknown outcomes using these exact bytes. Verify genuine committed membership.
4. Open R's current mailbox or committed staged envelope, check commitment and
   recover the complete signed key-history chain. Save/read back protected keys.

The durable journal retains candidate entryId, encrypted index-CAS intent,
selected entry, original ledger bytes, position and stage. A crash resumes that
identity. Failed candidates cannot be cleaned while any pending intent or current
index still references them. One workspace's progress does not advance another.

Expose paired, current envelope available and recoverable as separate states.
Recoverable requires active ledger R, an actually decryptable R package, trusted
genesis material and a current key whose commitment was checked. Keep last test
time and tested epoch separately; a successful old test does not cover a later
epoch. The user may explicitly skip setup after acknowledging recovery-path loss.

## New-device recovery and retention

A new device decrypts the selected R package, independently verifies the current
ledger and active R, opens the current key envelope and verifies every historical
packet. It generates its own independent personal device C. R signs C's
same-membership personal admission with real proof of possession; persist/retry
that original record through P09 and verify actual committed C. Continue as C and
drop temporary R handles and wipe owned secret byte buffers. WebCrypto exposes no
native-handle zeroization API; adapters must not retain those handles or export
R into a persistent ordinary device store. C inherits the user's current role.
Revoked R cannot admit another device. Historical sender revocation is not
silently relaxed for ordinary mailbox envelopes.

Active packages never expire automatically. Routine replacement verifies the
new package and R before retiring/revoking the old R. Known compromise prioritizes
revocation, even if recovery becomes temporarily unavailable. Retired ciphertext
remains until explicit user cleanup warns that recovery options may be lost.
Deleting cloud ciphertext does not revoke already copied secrets. Failed candidate
entries are retained permanently in this revision: there is no candidate garbage
collection API. A local journal cannot prove that another session has no pending
reference. Explicit risk-confirmed cleanup of retired indexed entries remains a
separate operation and requires an up-to-date index CAS.

## Boundaries and validation

Core defines platform-neutral encrypted storage and local-journal ports and owns
cryptography, index selection, setup and recovery. DTOs live in
`packages/cloud-api`; the private adapter owns authenticated cloud access, not
ledger authority. Lab SQLite implements immutable entries, index CAS and exact
transactional readback. Desktop custody is injected; synthetic Lab protection is
not a production keychain. Cloud login controls retrieval and the file controls
decryption, rather than providing cryptographic two-factor protection.

The [whitepaper](whitepaper.md), [permission ledger](permission-ledger.zh.md) and
[host protection](../../packages/e2ee-core/docs/workflows.md#installedepochkeys-and-installedepochhistory) define the
surrounding boundaries. This revision remains draft for human review; tests and
translation do not approve it or enable product E2EE.
