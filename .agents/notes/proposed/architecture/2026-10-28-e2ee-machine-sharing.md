# Owner-signed encrypted machine sharing

Status: proposed
Translation: current
PR: [#2014](https://github.com/LodyAI/Lody/pull/2014)

[中文](2026-10-28-e2ee-machine-sharing.zh.md)

## Abstract

Machine ownership in the verified ledger identifies who controls a machine, but does not authorize another member to execute on it. The proposed MVP keeps private defaults and existing machine/project switches through a separate, complete encrypted policy signed by the machine owner's active personal device. Server head CAS orders immutable versions while clients verify owner authority, exact resources and local version continuity. The public implementation supplies codecs, DTOs and a shared native host for policy originals, pins and execution freshness. Backend delivery and switch UI require their own integration and acceptance; the foundations Spec section remains pending approval. Availability uses bounded latest-state caches rather than requiring a network round trip for every action.

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

The platform transport and `cloud-api` share one DTO owner. The backend derives the authenticated device from its credential, verifies current machine-owner personal authority with `admitMachineSharingFrame`, and stores only ciphertext plus routing/CAS metadata. In one transaction it inserts the immutable original and updates the expected head. Exact request retries return their original receipt even after later revisions, or a removed barrier once purged; changed intent under a requestId fails, and confirmed conflicts require explicit new intent. Devices may read according to current workspace eligibility; only the machine owner may commit. Scope, revision, parent and requestId metadata must match the signed body when clients decrypt it.

Clients begin at revision one or their own trusted, resource-bound durable pin, verify each consecutive revision and reject gaps, forks and rollback. A server head is not itself cryptographic permission or freshness. For a fresh machine or a gap containing revoked signers, `verifyMachineSharingHistoryStep` authenticates historical membership and the hash chain but returns only a scratch head. Advance the accepted durable pin only after the final latest policy passes current owner-personal authority; never execute or accept a new pin from a historical step alone. `readMachineSharingHistoryStep` additionally returns authenticated full state so a new explicit owner intent can preserve the original project set. Its signer must have been admitted as a personal device of the bound membership; machine/recovery signatures fail even when they share that membership. It grants no current authority and does not prove publication time or then-current permission. The new intent must use revision n+1, the original frame digest, a fresh requestId and the currently valid owner-personal signer through `sealMachineSharingPolicy`; no automatic re-signing is authorized by the historical result. `openMachineSharingPolicy` returns module-created evidence; `authorizeMachineExecution` refuses copied/forged evidence and rechecks it against a current genuine ledger. Only the owner-personal signer is eligible to change policy; workspace Owner/Admin has no cross-member override. Recovery/Guest cannot execute, including through all-team sharing. Same-member machine replacement retains policy; a new membership instance does not inherit it. Revoking the signing personal device invalidates the old policy until another active owner device signs the next revision.

Machine removal retains a scoped removed head at the last committed revision/digest; the never-written case is 0/null. Reactivation requires explicit fresh owner intent, full status/scope/position CAS and revision n+1, never an old pending request. Atomic same-member replacement remains active. Version reads may return null after purge while readHead retains the removed high water. Cleanup uses a retained cutoff and cannot erase newer commits; minimal request intent receipts survive so removed retries do not resurrect ciphertext or reuse a requestId. The account-only `latestForMember` query exposes only ciphertext and untrusted routing/head data to current workspace members, separately from device-authenticated latest reads and all writes.

Purging originals prevents a fresh or lagging client from proving the full policy chain with the current core. A storage tombstone can supply a writer's CAS base, but is not a verified execution pin. Gap recovery belongs to an explicit A3 contract; absent that recovery, authorization stays pending rather than silently accepting the tombstone or skipping history. This is a remaining availability limit of physical cleanup, not a change to the signed format.

## Integration boundary and limits

A2 owns private storage, device-credential admission, atomic CAS, exact retry lookup and deletion cleanup. The shared native host in `packages/e2ee-machine-sharing` owns durable originals/pins, latest reads and invalidation. CLI execution resolves the actual local project and combines policy and ledger freshness at the shared RPC/durable actual-start gate. A4 owns the existing switch UI and verified visibility. These layers must preserve both actors' permission intersection for delegated execution; absent signed actor evidence keeps that entry closed.

Known withdrawal blocks new starts and subsequent authorized actions immediately, without killing already running commands. Unknown changes use strictly less than 15 minutes measured before latest-read I/O, intersected with ledger freshness and request deadlines; restart or clock uncertainty forces online revalidation. Persisted timestamps and policy issuedAt cannot renew a grant. Signatures/pins cannot reveal a newer version the server has never delivered. Availability failures affect dependent authorization only, leaving content reading and unrelated work available. The native integration adds no switch UI or task killing.

## Verification

[Behavioral coverage](../../../../packages/e2ee-core/test/machine-sharing.test.ts) uses synthetic deterministic identities, controlled nonces and explicit signing barriers. It exercises canonical encoding, full-state switches, owner/member/project binding, domain separation, current signer revocation, version continuity, future members, Guest/recovery exclusion and backend opaque-frame admission. Existing crypto vectors remain unchanged. This evidence does not establish deployed CAS, real-machine freshness or two-member product acceptance.

## Native host ownership

Policy storage opens only for policy-dependent work; corruption cannot block content reading or the same-member path. SQLite retains ciphertext, complete CAS identities, terminal request dispositions and resource-bound accepted heads. It retains the narrow local switch intent for retry comparison, but no credentials, keys or freshness. Concurrent completions compare durable high water atomically before publishing a cache entry; no account lock or database transaction spans network or cryptographic work.

The workspace Scope owns admitted operations, including writes whose callers stop waiting, and joins them before closing storage. Stop fences publication and preserves pending originals. Latest-read failure clears only dependent policy grants; failed storage opens remain retryable. Wall and monotonic clocks charge all latest-read I/O to the strictly shorter than 15-minute budget. The existing actual-start journal checks a synchronous policy/ledger-generation fence without an intervening await. Withdrawal leaves already-started tasks running.

Explicit re-signing uses authenticated historical complete state after issuer revocation, preserving projects with another current personal device. Historical state never supplies execution evidence or advances an accepted pin alone. A read traverses at most 4096 consecutive versions within its freshness interval; purged gaps without retained originals remain unavailable. Signatures cannot reveal withdrawals never delivered by the service.

Desktop personal signing stays behind `readMachineSharing` / `updateMachineSharing` host and IPC methods, forwarded by the real preload policy and CloudPlatformProvider. CLI machine custody consumes policies and exposes the same workflow but cannot sign owner changes; writing with that identity returns an ownership refusal. Delegated dispatch retains the two-actor permission intersection; display account IDs never become signed delegation evidence.

Native synthetic crypto/SQLite tests cover exact unknown-result recovery, terminal CAS conflict, current issuer revocation and explicit re-signing, project switches, rollback/removal barriers and clock limits. Production CLI construction and desktop/preload/provider regressions exercise actual adapters. This does not establish backend deployment, real keystore assurance or two-member/two-machine product acceptance.
