# Owner-signed encrypted machine sharing

Status: proposed
Translation: current
PR: [#2014](https://github.com/LodyAI/Lody/pull/2014)

[中文](2026-10-28-e2ee-machine-sharing.zh.md)

## Abstract

Machine ownership in the verified ledger identifies who controls a machine, but does not authorize another member to execute on it. The proposed MVP keeps private defaults and existing machine/project switches through a separate, complete encrypted policy signed by the machine owner's active personal device. Server head CAS orders immutable versions while clients verify owner authority, exact resources and local version continuity. This A1 supplies codecs, cryptographic gates and DTOs; storage, freshness, native host execution and UI still need integration, and the new foundations Spec section remains pending approval. Availability uses bounded latest-state caches rather than requiring a network round trip for every action.

## Decision and alternatives

Keep machine sharing outside the membership ledger: changing a project switch must not add a permanent membership operation. One complete policy makes enabling a project and its machine atomic, and lets disabling the machine retain project records. Ordinary CRDT booleans or snapshot signatures cannot establish that each switch came from its machine owner. Account-based server authorization would give the server authority over sharing; default access to every team machine would remove owner control and private defaults. Neither alternative preserves the chosen boundary.

The active machine binding remains owned by the [machine identity decision](2026-10-27-e2ee-machine-ledger-binding.md). This proposal adds sharing authority without superseding that decision or the existing realtime primitive/journal ownership. The supersession search found no existing owner for the sharing-policy format. Earlier sharing-disabled UI remains unchanged by A1.

## Format and ownership

The canonical bounded CBOR tuple is:

```text
[format=1, purpose=1, workspaceIdUtf8, genesis32, machineIdUtf8,
 ownerMembership16, revision, previousFrameDigest32OrNull, sharedWithTeam,
 sortedProjectIdUtf8s, signer32, issuedAt, requestId16]
```

Identity strings are strict UTF-8, 1..256 bytes, without normalization or BOM stripping. Projects form a duplicate-free bytewise sorted set, at most 4096 entries; the expanded body is at most 256 KiB. Signature keys retain the core's strict Ed25519 validation. Time is a nonnegative safe integer, descriptive only. Revision is a positive safe integer; only revision one has a null parent. Hashes and public DTO IDs use canonical lowercase hex.

Content-v0 document-update encryption/signature fixes resource `machine-access:<unpadded-base64url(machineIdUtf8)>:<ownerMembershipIdHex>`, docEpoch zero, and additional signature/AAD binding `lody-e2ee/machine-sharing/v1\0`. This reuses the existing algorithms and ledger format. Hash the complete original encrypted frame with SHA-256 for both CAS and previousDigest; do not hash decoded state or re-encrypt retries. The original frame limit is 262287 bytes (256 KiB body plus 143).

The platform transport and `cloud-api` share one DTO owner. The backend derives the authenticated device from its credential, verifies current machine-owner personal authority with `admitMachineSharingFrame`, and stores only ciphertext plus routing/CAS metadata. In one transaction it inserts the immutable original and updates the expected head. Exact request retries return their original receipt even after later revisions; changed intent under a requestId fails, and confirmed conflicts require explicit new intent. Devices may read according to current workspace eligibility; only the machine owner may commit. Scope, revision, parent and requestId metadata must match the signed body when clients decrypt it.

Clients begin at revision one or their own trusted, resource-bound durable pin, verify each consecutive revision and reject gaps, forks and rollback. A server head is not itself cryptographic permission or freshness. For a fresh machine or a gap containing revoked signers, `verifyMachineSharingHistoryStep` authenticates historical membership and the hash chain but returns only a scratch head. Advance the accepted durable pin only after the final latest policy passes current owner-personal authority; never execute or accept a new pin from a historical step alone. `openMachineSharingPolicy` returns module-created evidence; `authorizeMachineExecution` refuses copied/forged evidence and rechecks it against a current genuine ledger. Only the owner-personal signer is eligible to change policy; workspace Owner/Admin has no cross-member override. Recovery/Guest cannot execute, including through all-team sharing. Same-member machine replacement retains policy; a new membership instance does not inherit it. Revoking the signing personal device invalidates the old policy until another active owner device signs the next revision.

## Integration boundary and limits

A2 owns private storage, device-credential admission, atomic CAS, exact retry lookup and deletion cleanup. A3 owns durable originals/pins, real execution-target resolution, authenticated latest ledger/policy reads, invalidation, and the shared RPC/durable actual-start gate. A4 owns the existing switch UI and verified visibility. These layers must preserve both actors' permission intersection for delegated execution; absent signed actor evidence keeps that entry closed.

Known withdrawal blocks new starts and subsequent authorized actions immediately, without killing already running commands. Unknown changes use strictly less than 15 minutes measured before latest-read I/O, intersected with ledger freshness and request deadlines; restart or clock uncertainty forces online revalidation. Persisted timestamps and policy issuedAt cannot renew a grant. Signatures/pins cannot reveal a newer version the server has never delivered. Availability failures affect dependent authorization only, leaving content reading and unrelated work available. A1 implements no cache, network, UI, task killing or execution wiring.

## Verification

[Behavioral coverage](../../../../packages/e2ee-core/test/machine-sharing.test.ts) uses synthetic deterministic identities, controlled nonces and explicit signing barriers. It exercises canonical encoding, full-state switches, owner/member/project binding, domain separation, current signer revocation, version continuity, future members, Guest/recovery exclusion and backend opaque-frame admission. Existing crypto vectors remain unchanged. This evidence does not establish deployed CAS, real-machine freshness or two-member product acceptance.
