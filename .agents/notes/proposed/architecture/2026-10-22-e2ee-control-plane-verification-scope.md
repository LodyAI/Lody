# E2EE control plane verifies signatures only for ledger records

Status: proposed
Translation: current

[中文](2026-10-22-e2ee-control-plane-verification-scope.zh.md)

## Abstract

The original design had the server verify signatures in many places: a one-time possession challenge before issuing access tokens, and signature checks on every mailbox, staging and join request. Access tokens renew about every 15 minutes, so this work sat on a hot path, while everything it rejected is already rejected by recipients that verify before use. On 2026-10-21 the owner decided that the control-plane services (ledger, key delivery, access credentials and join requests) verify signatures only when accepting ledger records. All other requests identify the device by an access credential bound at admission and check the device state the server maintains while accepting ledger records. The owner also confirmed that machine devices without an OS keystore keep their keys in a file readable only by their user, disclosed at pairing approval. This record revises only the Specs and backend guide; the server implementation has not started.

## Context and problem

- The whitepaper required hosts to verify key possession through a one-time challenge when issuing and renewing JWTs, to verify the sending device's signature before storing an envelope, to have the gateway verify envelope signatures, and to verify join-request signatures first.
- Access tokens last about 15 minutes. A possession challenge on every renewal, plus loading ledger state and verifying newer records, would land on the hot path of every active device.
- Only the ledger must be guarded by the server before writing. It is append-only, so one invalid record would stop every client at that record and permanently block the workspace control plane. Invalid envelopes, installation reports, staged groups and join requests are rejected by recipients, which verify signatures and commitments before use.

## Decision

1. **Signatures are verified only when accepting ledger records.** Creation, append and recovery writes keep full verification; other control-plane requests involve no server-side cryptographic verification.
2. **Device access credential.** At admission a device generates a random credential. The server stores only its hash, bound to (workspace, signing public key), either in the creation request or when an `admitDevice` record is submitted. The approving client locally verifies the new device's signature over "pairing session ‖ credential hash", so nobody can bind their own credential to someone else's key.
3. **Device-state projection.** The server updates "device active, kind and role" in the same transaction that accepts ledger records. Token issuance, mailbox and staging read only this table, and revocation takes effect when it is written.
4. **Structural mailbox and staging checks.** The sender must be the credential's device, the recipient a current device and the epoch current; bytes are immutable; per-sender limits apply. Hosts that want more can still call the `@lody/e2ee-core/host` verification helpers (the backend guide's optional tier).
5. **Machine file custody.** On first creation a machine selects file protection if an OS keystore write/read-back probe fails, and never switches automatically later. Personal devices use OS secure storage only. Pairing approval must disclose file protection. Implementation: [M1 runtime boundaries](../../implemented/architecture/2026-10-21-e2ee-m1-runtime-boundaries.md).

## Alternatives considered

- **Possession challenge before each token issuance** (original Spec): two round trips plus ledger state on every renewal. The only extra case it covers is a stolen credential, which equals a compromised device and is handled by revocation and rotation.
- **Chained nonces to save a round trip:** still needs server-side signature verification and nonce state, so the complexity remains.
- **Server-side verification for every control-plane request:** the most expensive option. Recipients verify again anyway; a second check on the server only stops an authenticated device from filling its own slots with junk.

## Trade-offs and limits

- **Misbehavior:** an authenticated device can at most place invalid data in envelopes it sends and in its own slots, within per-sender limits and attributable to it. Recipients reject the data and request repair. It cannot impersonate another device or obtain keys.
- **Credential leak:** equivalent to device compromise; handled by revocation and rotation. Credentials do not rotate.
- **Scope:** content write admission is out of scope; whitepaper §4.2 and the pending write-admission decision own it.
- **Approval:** the corresponding Spec revisions remain drafts awaiting owner approval. The server implementation of credentials, projection, mailbox and staging has not started.

## Evidence

- Specs: [whitepaper](../../../../specs/e2ee/whitepaper.md) implementation decisions, §4, §4.1, §5.3, §7; [permission ledger (Chinese)](../../../../specs/e2ee/permission-ledger.zh.md) §4.4, §6.1, §9.
- Backend guide: [`backend-guide.md`](../../../../packages/e2ee-core/docs/backend-guide.md) authentication, mailbox and staging sections.
- Related records: [current E2EE decisions](../../implemented/architecture/2026-10-15-e2ee-current-decisions.md), [open contracts](2026-10-15-e2ee-open-contracts.md).
