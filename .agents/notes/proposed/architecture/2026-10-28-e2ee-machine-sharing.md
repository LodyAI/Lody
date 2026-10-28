# Owner-signed encrypted machine sharing

Status: proposed
Translation: current
PR: [#2014](https://github.com/LodyAI/Lody/pull/2014), [#2018](https://github.com/LodyAI/Lody/pull/2018), [#2033](https://github.com/LodyAI/Lody/pull/2033)

[中文](2026-10-28-e2ee-machine-sharing.zh.md)

## Abstract

Machine ownership identifies who controls a machine but cannot authorize another member to execute on it. The proposed MVP retains private defaults and machine/project switches through a complete encrypted policy signed by the machine owner's active personal device. A ledger-qualified binding generation isolates removal/readmission from atomic key replacement: removal starts a new resource at revision one, so deleted policy history cannot block recovery or resurrect an old grant. Server CAS orders versions within each generation; A1 supplies inert codecs, generation evidence, authorization and DTOs while storage, host execution and UI remain separate. Unknown revocation latency against a server withholding current heads is not bounded by a short local cache; on 2026-10-28, the owner confirmed acceptance of trusting the server not to continuously withhold newer heads.

## Decision and alternatives

Keep sharing outside the membership ledger: a project switch must not become a permanent membership operation. A complete policy makes enabling a project and its machine atomic; disabling the machine retains project records. CRDT booleans or snapshot signatures cannot establish that each switch came from its machine owner. Account-based sharing would give the server authority; default all-team machine access would remove private defaults. Both alternatives lose the selected boundary.

The [machine identity decision](2026-10-27-e2ee-machine-ledger-binding.md) continues to own ledger binding and atomic replacement. This proposal adds no ledger record, capability, snapshot/retained-state format change or competing owner note. The existing ordinary sharing UI stays disabled for encrypted workspaces; their controls use the native policy workflow below. Realtime/journal responsibilities remain unchanged.

## Generation and removal

`generation` is lowercase hex32 of the signing key in the initial machine AdmitDevice (`replaces=null`) of the currently active, uninterrupted replacement chain. Verified ledger rules permanently forbid key reuse. Every subsequent atomic replacement names the previous active key, so it preserves that root. Revocation/removal followed by readmission has a new initial key, hence a different generation even for the same member and machineId. Generation is not a server counter, timestamp or client-chosen string.

`verifyMachineSharingGeneration` requires the initial admission and every replacement through the current device, each as `{record,length}` where length is its one-based ledger position. It checks each original hash at that exact position in a genuine ledger, increasing positions, machine/member identity and exact replaces links. The result is an opaque module-created token tied to that view and current device. Every policy operation and execution decision requires this token and rechecks its current binding. At most 4096 admission records are accepted. Compact snapshot/retained views cannot invent missing ledger checkpoints: qualify against a genuine view retaining the originals' checkpoints (normally full replay) at the current endpoint, then use that evidence with a same-position compact view or its continuation. An unavailable proof affects this machine's sharing/execution only, not reading documents or unrelated work.

All DTO scopes, signed bodies, resources, local journals, cache keys and policy pins include generation. Removal marks the old generation terminal and records its cleanup cutoff/high water; no new commit may reactivate it. A new generation uses no old policy pin or grants and begins at revision 1/null parent. A fresh explicit owner intent is required to share again. Atomic replacement remains in the same generation and keeps policy. This replaces the rejected approach of continuing n+1 after physical cleanup: status-only CAS prevents some stale writes but cannot make a fresh client verify a deleted prefix, and old policy evidence could otherwise survive readmission.

## Format and responsibilities

Canonical bounded CBOR is current-only v2:

```text
[format=2, purpose=1, workspaceIdUtf8, genesis32, machineIdUtf8,
 ownerMembership16, revision, previousFrameDigest32OrNull, sharedWithTeam,
 sortedProjectIdUtf8s, signer32, issuedAt, requestId16, generation32]
```

Identity strings are strict UTF-8, 1..256 bytes, with no normalization/BOM stripping. Projects are a duplicate-free bytewise sorted set, at most 4096; expanded body is at most 256 KiB. Public keys retain strict Ed25519 validation. issuedAt is a nonnegative safe Unix-millisecond integer, descriptive only. Revision is a positive safe integer; only revision one has a null parent. Public DTO hex is lowercase.

Existing content-v0 document-update crypto fixes resource `machine-access:<unpadded-base64url(machineIdUtf8)>:<ownerMembershipIdHex>:<generationHex>`, docEpoch zero and signature/AAD binding `lody-e2ee/machine-sharing/v2\0`. Hash the complete original encrypted frame with SHA-256, not decoded state; the frame maximum remains 262287 bytes. Retain originals for uncertain retries, never re-encrypt or automatically rebase them. No v1 policy reader, fallback or silent conversion exists.

The backend uses credential-derived identity, current ledger-qualified generation and `admitMachineSharingFrame`. In the same atomic mutation it rechecks current personal/member/machine eligibility and generation, compares full scope/status/revision/digest, deduplicates request intent and inserts original plus head. An old-generation pending request conflicts even if its revision/digest equals a fresh resource's values. Exact committed retries return their receipt, or removed after purge; changed intent under a requestId fails. Minimal request intent receipts and removal cutoff survive cleanup. Cleanup is bound to the old generation and cannot delete new-generation commits. Purged version reads may return null; readHead retains the old removed high water, never promoting it to a trusted pin. Account-only `latestForMember` returns ciphertext/untrusted metadata to current workspace members, without execution freshness.

`readMachineSharingHistoryStep` returns authenticated same-generation full state from a historically admitted owner-personal device, including after signer revocation. It creates no execution credential and proves neither publication time nor then-current permission. Only fresh explicit owner intent may preserve that state at n+1 within the same generation through the currently valid personal signer. Machine/recovery signatures fail as recovery input. `openMachineSharingPolicy` and `authorizeMachineExecution` still require current owner-personal authority; Guest/recovery never execute and all-team includes future qualified members. History readers do not skip missing history within a live generation.

## Integration and trust limits

A2 owns private storage, device admission, generation-aware CAS, receipts and cleanup. A3 owns qualification of generation evidence, exact originals/pins, actual local-project resolution, authenticated ledger/head reads and the common RPC/durable actual-start gate. A4 owns the existing switch UI and verified visibility. Delegated execution retains both actors' permission intersection; absent signed actor evidence keeps that entry closed. Withdrawal blocks new starts and subsequent authorized actions without killing running commands.

Observed withdrawal invalidates permission immediately. A strictly less than 15-minute memory cache bounds the age of the client's authenticated read, measured before I/O and intersected with ledger/request deadlines. It does not bound unknown withdrawal against a server repeatedly withholding newer control state: signatures/chains detect known rollback and forks but cannot prove a globally latest head. On 2026-10-28, the owner confirmed acceptance of trusting the server not to continuously withhold newer heads; no new cryptographic freshness witness is introduced. Restart/clock uncertainty requires revalidation. Failures remain scoped to dependent authorization, preserving offline content and unrelated work.

## Verification

[Behavioral coverage](../../../../packages/e2ee-core/test/machine-sharing.test.ts) uses deterministic synthetic identities/nonces and explicit signing barriers. It covers same-member removal/readmission, old prepared writes and cached execution evidence, fresh revision-one bootstrap without old policy bytes, private defaults, explicit re-sharing, atomic replacement continuity, ledger-position/proof substitution, compact-view qualification, owner-personal historical body recovery and full-project preservation on re-sign. Existing ledger/crypto vectors remain unchanged. No deployed CAS, real-machine freshness or two-member product acceptance is claimed.

## Native host ownership

Policy originals, request reconciliation, rollback pins and RAM caches include the ledger-qualified generation. Hosts select admission/replacement originals from local history and use core to authenticate each exact position; compact views may qualify through full local replay at the same authenticated endpoint. Missing evidence denies sharing only and leaves same-member execution independent. Desktop reads return generation and updates require it, so old-window intents cannot silently enable a readmitted machine. Removal is terminal in that generation; fresh explicit intent starts revision one in the new resource.

Policy storage opens only for policy-dependent work; corruption cannot block content reading or the same-member path. SQLite retains ciphertext, complete CAS identities, terminal request dispositions and resource-bound accepted heads. It retains the narrow local switch intent for retry comparison, but no credentials, keys or freshness. Concurrent completions compare durable high water atomically before publishing a cache entry; no account lock or database transaction spans network or cryptographic work.

The workspace Scope owns admitted operations, including writes whose callers stop waiting, and joins them before closing storage. Stop fences publication and preserves pending originals. Latest-read failure clears only dependent policy grants; failed storage opens remain retryable. Wall and monotonic clocks charge all latest-read I/O to the strictly shorter than 15-minute budget. The existing actual-start journal checks a synchronous policy/ledger-generation fence without an intervening await. Withdrawal leaves already-started tasks running.

Explicit re-signing uses authenticated historical complete state after issuer revocation, preserving projects with another current personal device. Historical state never supplies execution evidence or advances an accepted pin alone. A read traverses at most 4096 consecutive versions within its freshness interval; purged gaps without retained originals remain unavailable. Signatures cannot reveal withdrawals never delivered by the service.

Desktop personal signing stays behind `readMachineSharing` / `updateMachineSharing` host and IPC methods, forwarded by the real preload policy and CloudPlatformProvider. CLI machine custody consumes policies and exposes the same workflow but cannot sign owner changes; writing with that identity returns an ownership refusal. Delegated dispatch retains the two-actor permission intersection; display account IDs never become signed delegation evidence.

Native synthetic crypto/SQLite tests cover exact unknown-result recovery, terminal CAS conflict, current issuer revocation and explicit re-signing, project switches, rollback/removal barriers and clock limits. Production CLI construction and desktop/preload/provider regressions exercise actual adapters. This does not establish backend deployment, real keystore assurance or two-member/two-machine product acceptance.

## Settings authority and recovery

The encrypted machine settings surface renders native `canManage`, verified signer,
revision and re-sign status. Account/machine/generation fences discard stale UI
results. Ordinary workspaces never open these policy ports. Current owners alone
can change machine/project switches; other members see read-only policy and a
friendly refusal. Revoked signer state remains historical display/re-sign input,
not execution evidence. Re-signing first refreshes complete state and keeps every
project, including projects absent from the current inventory.

An uncertain write retains its exact generation, requestId and narrow change;
refresh or window remount discovers the native durable pending intent. Explicit
retry reconciles that same original. A confirmed conflict requires a fresh read
and explicit new requestId; a new admission generation discards the old UI intent
and requires a new owner action. Panel failures never block other settings.
The surface explains future-member sharing, Guest/recovery exclusion and that
withdrawal leaves already-running tasks alone. Production provider/preload tests
exercise pending/remount recovery, conflict, re-signing, scope changes and friendly
English/Chinese refusals; synthetic Storybook captures establish presentation only.
