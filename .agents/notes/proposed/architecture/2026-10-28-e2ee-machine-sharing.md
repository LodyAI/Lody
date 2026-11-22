# Owner-signed encrypted machine sharing

Status: proposed
Translation: current
PR: [#2014](https://github.com/LodyAI/Lody/pull/2014), [#2018](https://github.com/LodyAI/Lody/pull/2018), [#2033](https://github.com/LodyAI/Lody/pull/2033), [#2144](https://github.com/LodyAI/Lody/pull/2144), [#2147](https://github.com/LodyAI/Lody/pull/2147)

[中文](2026-10-28-e2ee-machine-sharing.zh.md)

Intent and guarantees: [machine sharing Spec](../../../../specs/e2ee/machine-sharing.md) (approved).

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

Canonical bounded CBOR is current-only v3:

```text
[format=3, purpose=1, workspaceIdUtf8, genesis32, machineIdUtf8,
 ownerMembership16, revision, previousFrameDigest32OrNull, sharedWithTeam,
 sortedProjectIdUtf8s, signer32, issuedAt, requestId16, generation32, sortedSessionGrants[[sessionIdUtf8, audience=0|userIdUtf8, read=1]]]
```

Identity strings are strict UTF-8, 1..256 bytes, with no normalization/BOM stripping. Projects are a duplicate-free bytewise sorted set, at most 4096; expanded body is at most 256 KiB. Public keys retain strict Ed25519 validation. issuedAt is a nonnegative safe Unix-millisecond integer, descriptive only. Revision is a positive safe integer; only revision one has a null parent. Public DTO hex is lowercase.

Existing content-v0 document-update crypto fixes resource `machine-access:<unpadded-base64url(machineIdUtf8)>:<ownerMembershipIdHex>:<generationHex>`, docEpoch zero and signature/AAD binding `lody-e2ee/machine-sharing/v3\0`. Hash the complete original encrypted frame with SHA-256, not decoded state; the frame maximum remains 262287 bytes. Retain originals for uncertain retries, never re-encrypt or automatically rebase them. No v1 policy reader, fallback or silent conversion exists.

The backend uses credential-derived identity, current ledger-qualified generation and existing core `machineSharingContentScope` / `verifyContentSignature` primitives. In the same atomic mutation it rechecks current personal/member/machine eligibility and generation, compares full scope/status/revision/digest, deduplicates request intent and inserts original plus head. An old-generation pending request conflicts even if its revision/digest equals a fresh resource's values. Exact committed retries return their receipt, or removed after purge; changed intent under a requestId fails. Minimal request intent receipts and removal cutoff survive cleanup. Cleanup is bound to the old generation and cannot delete new-generation commits. Purged version reads may return null; readHead retains the old removed high water, never promoting it to a trusted pin.

The owner confirmed on 2026-11-09 that E2EE has no production data: only v3 is supported, without older-format reading, migration or reset scripts. Each read and pre-write verifies only the latest original, its historically admitted owner-personal signature, resource/binding/generation and local high-water pin. Lower revisions and differing digests at equal revisions fail. Cold clients can accept any positive revision and skip purged intermediate policies. `previousDigest` remains server CAS ordering, not client chain evidence. The machine-generation admission chain is still ledger-verified and is separate from policy history.

Independent `sessions: [{sessionId, audience: 'team' | {userId}, level: 'read'}]` grants do not enable the machine or any project. Identities are bounded and canonical like project IDs. Older clients reject v3 and v3 rejects older policies. Deploy compatible server admission before clients; no ledger format changes.

On 2026-11-10 the owner chose availability after signer revocation: the latest
service-accepted policy continues authorizing if its signer was admitted as a personal
device of the current owner membership. The service must refuse revoked credentials
at commit; a valid current owner device still signs all new intent. Signing time is
not cryptographically provable, so this extends the accepted nonmalicious-service
premise. `needsResign` advises review without hiding grants or disabling controls.
Re-signing preserves the complete machine/project/team/member-session list. The
latest-only signature/binding/generation/resource and monotonic pin checks remain;
Guest, recovery and machine policy signers fail. This supersedes the 2026-11-09
private-default re-sign choice without restoring a policy-history traversal API.

## Integration and trust limits

A2 owns private storage, device admission, generation-aware CAS, receipts and cleanup. A3 owns qualification of generation evidence, exact originals/pins, actual local-project resolution, authenticated ledger/head reads and the common RPC/durable actual-start gate. A4 owns the existing switch UI and verified visibility. Delegated execution retains both actors' permission intersection; absent signed actor evidence keeps that entry closed. Withdrawal blocks new starts and subsequent authorized actions without killing running commands.

Observed withdrawal invalidates permission immediately. A strictly less than 15-minute memory cache bounds the age of the client's authenticated read, measured before I/O and intersected with ledger/request deadlines. It does not bound unknown withdrawal against a server repeatedly withholding newer control state: signatures/chains detect known rollback and forks but cannot prove a globally latest head. On 2026-10-28, the owner confirmed acceptance of trusting the server not to continuously withhold newer heads; no new cryptographic freshness witness is introduced. Restart/clock uncertainty requires revalidation. Failures remain scoped to dependent authorization, preserving offline content and unrelated work.

A cached grant retains that window. A cached `machine-not-shared` or
`project-not-shared` denial instead triggers an authenticated latest-head read before
refusal, and a newly verified grant admits the request immediately. One binding,
including generation, shares concurrent refreshes and allows one attempt per five
seconds from read start. The short cooldown limits request traffic while bounding
local delay for newly granted access; it does not shorten revocation freshness.

The workspace Scope owns this native Effect producer, so cancellation of one waiter
does not cancel another waiter's read. Coordination holds a permit only while
selecting a producer, never over network or crypto work; independent bindings and
same-member execution remain available. A failed attempt retains only a retry stamp,
not a failed fiber or policy result. It falls back to the accepted pinned denial or
the existing unavailable outcome, never advances a pin or publishes a grant. After
the cooldown, the next request retries. Invalidation retires coordination and the
existing read-publication fence still rejects late grants; Scope close interrupts
and joins the producer before storage closes. The host suite exercises grant
refresh, concurrent refusal, cooldown expiry and failed-read denial retention.

## Verification

[Behavioral coverage](../../../../packages/e2ee-core/test/machine-sharing.test.ts) uses deterministic synthetic identities/nonces and explicit signing barriers. It covers same-member removal/readmission, old prepared writes and cached execution evidence, fresh revision-one bootstrap without old policy bytes, private defaults, explicit re-sharing, atomic replacement continuity, ledger-position/proof substitution, compact-view qualification, latest-only cold reads across purged revisions and retained-grant re-sign after revocation. Existing ledger/crypto vectors remain unchanged. No deployed CAS, real-machine freshness or two-member product acceptance is claimed.

## Native host ownership

Policy originals, request reconciliation, rollback pins and RAM caches include the ledger-qualified generation. Hosts select admission/replacement originals from local history and use core to authenticate each exact position; compact views may qualify through full local replay at the same authenticated endpoint. Missing evidence denies sharing only and leaves same-member execution independent. Desktop reads return generation and updates require it, so old-window intents cannot silently enable a readmitted machine. Removal is terminal in that generation; fresh explicit intent starts revision one in the new resource.

Policy storage opens only for policy-dependent work; corruption cannot block content reading or the same-member path. The store (SQLite on desktop and CLI, IndexedDB in browsers and webviews) retains ciphertext, complete CAS identities, terminal request dispositions and resource-bound accepted heads. It retains the narrow local switch intent for retry comparison, but no credentials, keys or freshness. Concurrent completions compare durable high water atomically before publishing a cache entry; no account lock or database transaction spans network or cryptographic work.

The workspace Scope owns admitted operations, including writes whose callers stop waiting, and joins them before closing storage. Stop fences publication and preserves pending originals. Latest-read failure clears only dependent policy grants; failed storage opens remain retryable. Wall and monotonic clocks charge all latest-read I/O to the strictly shorter than 15-minute budget. The existing actual-start journal checks a synchronous policy/ledger-generation fence without an intervening await. Withdrawal leaves already-started tasks running.

Latest-only reads remove the former 4096-policy traversal and dependence on purged originals. Active signatures and local pins still protect authority, known rollback and forks, but cannot reveal a newer head withheld by the service.

Desktop personal signing stays behind `readMachineSharing` / `updateMachineSharing` host and IPC methods, forwarded by the real preload policy and CloudPlatformProvider. CLI machine custody consumes policies and exposes the same workflow but cannot sign owner changes; writing with that identity returns an ownership refusal. Delegated dispatch retains the two-actor permission intersection; display account IDs never become signed delegation evidence.

Synthetic crypto tests, run against both the SQLite and IndexedDB stores, cover exact unknown-result recovery, terminal CAS conflict, current issuer revocation and explicit re-signing, project switches, rollback/removal barriers and clock limits. Production CLI construction and desktop/preload/provider regressions exercise actual adapters. This does not establish backend deployment, real keystore assurance or two-member/two-machine product acceptance.

## Settings authority and recovery

The encrypted machine settings surface renders native `canManage`, verified signer,
revision and re-sign status. Account/machine/generation fences discard stale UI
results. Ordinary workspaces never open these policy ports. Current owners alone
can change machine/project switches; other members see read-only policy and a
friendly refusal. A revoked issuer produces a nonblocking review reminder. Re-signing
refreshes and retains the entire current list, including undisplayed grants.

An uncertain write retains its exact generation, requestId and narrow change;
refresh or window remount discovers the native durable pending intent. Explicit
retry reconciles that same original. A confirmed conflict requires a fresh read
and explicit new requestId; a new admission generation discards the old UI intent
and requires a new owner action. Panel failures never block other settings.
The surface explains future-member sharing, Guest/recovery exclusion and that
withdrawal leaves already-running tasks alone. Production provider/preload tests
exercise pending/remount recovery, conflict, re-signing, scope changes and friendly
English/Chinese refusals; synthetic Storybook captures establish presentation only.

## Member visibility (A4)

Encrypted workspaces skip the ordinary machine and project visibility queries, so
until this change a member saw only their own machines and could not start a turn on
a machine the owner had shared. `useEncryptedSharedMachines` keeps one store per
account and workspace, shared by every consumer of the visible index. For each synced
machine owned by another member, it reads the host's verified `readMachineSharing` view
and treats the machine as usable only when core reported no `deniedReason` and the view
is shared, current, not removed and available. Guest exclusion and withdrawal therefore
come from core, never from server machine tables or display account IDs. Signed
`projects` become the visible projects of that machine; a projectless conversation
needs only the machine.

Reads run at most two at a time and never block other workspaces or the index's other
sources. A newer read of a machine supersedes an older one. Ledger changes, `online`,
returning visibility and a 10-minute interval refresh the views, which stays inside the
owner-approved bound of under 15 minutes for unknown withdrawal. A denial, removal or
failed read removes access immediately. These are host IPC reads, not Streams
subscriptions.

Shared encrypted machines are exposed for selection and execution only. They stay out
of the Convex-backed authorized set, so startup capability probes never launch agents
on another member's machine. `withoutEncryptedSharedMachines` also keeps them out of
automatic agent-config migration, bug-report log collection and memory-provider
settings, which use fenced machine RPC or write a machine's catalog.

On 2026-11-09 the owner superseded the former A4 all-history visibility decision and the header audience-strip rule in the 2026-09-14 session-header-share-control note. Both workspace modes now default to private. Machine owners always see and manage their machine's conversations; usable shared machines and local projects retain editing; independent authoritative session grants expose only read-only history. On 2026-11-10 the owner restored assigned-session-owner read visibility through
`SessionMeta.userId`, without management or execution authority. A grant applies only on its bound machine, and contained children follow their root; opened-by provenance grants nothing.

The common platform `sessionAccess` port uses ordinary owner-controlled machine rows or E2EE v3 signed session grants. Convex subscriptions invalidate ordinary views; E2EE subscribes to machine/generation/revision hints and reloads verified policy. Deep links force a machine policy read. None of these grants expands machine execution indexes. Private history is hidden by the interface only: workspace members still hold content keys, so this is not cryptographic privacy.

The independent history reader has no composer, execution controls or management writes. It retains pin/unread, Markdown copy and a reference in a new conversation. `useSessionActions` re-reads actual Repo targets and current authority for management; retained callbacks cannot bypass revocation or metadata machine changes. Pin/unread use a narrow preference path. Roost uses an exact-session reader: an ordinary app proof binds its account; a CLI proof binds the credential account,
declared requester and source machine. Mint preflight and serving-machine verification
require both accounts' target authority and current requester admission on the
account-owned source machine. The declared identity is not separately authenticated;
checking it alone would let a shared source impersonate a private target's owner.
Target verification uses actual metadata, not the mint snapshot. E2EE source reads
likewise retain both principals' permission intersection. Encrypted read permits
retain ledger-generation and verified-policy fences across waits, reads, encryption
and publication; actual metadata access is checked again after stream creation.
Cached replies follow the same checks. Read admission never authorizes writes, execution, files or other sessions. The draft [session access Spec](../../../../specs/session-access.md) records the full contract and later phases. Deterministic suites are implementation evidence, not a two-member product acceptance run.

## Sender withdrawal gate

Before any metadata, receipt or history write, an encrypted send prepares its dispatch. A
verified denial, `e2ee_machine_not_shared`, fails the send as not sent, and the composer keeps
the draft. An unverifiable policy, a host with no policy reader, a timeout or a transport
failure stays unknown: the input is written as usual and the receiving machine decides. The
check runs before the write, not as a repair afterwards.

A verified withdrawal must stay known. The host derives it from the resource's
accepted pin, which is bound to workspace, genesis, machine, owner and generation, and
advances only on a newer verified head. A failed, rolled-back or expired refresh never
rewrites that pin. `knownDenial` re-opens the pinned policy locally. A denial uses the pinned current policy. A signer never admitted as an owner-personal device, or a removed owner membership, yields denial. Later personal-device revocation alone preserves the service-accepted policy grants and advises nonblocking review. `authorize`
returns that denial instead of an unknown failure, and the desktop prepare checks it
before any network read. Only a newer verified read, such as the visible-index refresh
or the settings view, releases it. The renderer also remembers each verified
withdrawal for its runtime until a later prepare succeeds. A prepare that outlasts its
200 ms deadline for such a machine is refused. For any other machine it stays unknown:
the turn is written, and if the late answer is a verified withdrawal, the turn becomes
`canceled`. That uses a commit-time `onlyAwaitingStart` guard, so a turn that a machine
has already claimed keeps its own outcome. The guard protects only this replica's
commit: a concurrent offline copy can still merge over `canceled`. The cancellation is
best effort, not proof of a global withdrawal; the machine's owner-approved window
still bounds that case. Queued rows have no history turn to settle and rely on the
same window.

Policies live in the server's sharing store, not in workspace data the machine
syncs. Its execution check reuses an authenticated grant younger than 15 minutes;
cached denials use the five-second refresh rule above. A withdrawal that the machine has not yet
observed is the owner-approved unknown window. The host test pins both halves: the
fresh grant survives an unobserved withdrawal, and the host's own verified read denies
at once. A send that a sender knew was withdrawn is refused before any write; a sender
that cannot verify still relies on that window.

A re-paired machine starts a new generation with no policy. An authenticated read that
finds no head for the current generation, or its removal, is therefore the private
default: a known denial (`machine-not-shared`), not an unknown outcome. Before this, a
member's prepare reported the unknown result, which the desktop boundary mapped to
`invalid-ledger`; the desktop now maps a genuinely unverifiable policy to
`sharing_unavailable`. A later owner share in the new generation is read and admitted by
the same process, because caches and pins are generation-scoped.

## Project scope at the receiving machine

A member granted project P1 on a shared machine could run in an unshared project P2:
the CLI claimed execution before it recorded the turn's project, so the gate received
no project and checked only the machine switch. The claim now authorizes every local
project the turn can reach, resolved on the machine before any worktree, process or
prompt. That set unites the request, synced Session metadata, the live process's own
machine-held configuration, a child Tab's parent, and Project group members, including
every local copy that an unpinned repository member may use. Any one unshared project
denies. Extra sources only add projects to check, so a member editing synced metadata
cannot remove the project a live process actually uses. Directories come only from
this machine's registry by ID; no requested path, working directory or worktree path
is accepted, so there is no caller-controlled subdirectory or symlink to escape
through. Same-member execution is unchanged.

Two follow-ups close what an independent review found. A restore no longer rereads
synced metadata after authorization: it starts from the project, Project group and
parent it authorized, and create and restore recompute the scope immediately before a
process starts, refusing anything outside the authorized set. Registry rows are synced,
so any member can write them; in encrypted workspaces a row counts only while its
`rootPath` still hashes to its project ID, which this machine derived from the canonical
root it registered. A rewritten path therefore resolves as missing instead of
redirecting an authorized project. Registration, root reconciliation and this check all
canonicalize through `localProjectsLegacy` with the native `realpath`, so on-disk case on
a case-insensitive volume hashes the same each time; the non-native Effect path layer
never creates IDs and must not be used for this check.

The session manager also rereads synced Project groups and parent projects while it
prepares directories, so that reread happens after the claim. Every such read now
passes `SessionConfig.authorizeExecutionInputs`, which recomputes the scope for the
snapshot actually used and rejects any project outside the authorized set before a
member is resolved or a directory is prepared.

A projectless conversation (`kind: 'none'`, a Lody-managed chat directory or managed
GitHub clone) needs only the machine switch. The draft foundations Spec makes absent
projects private and requires "actual local projects" to have their own switch, while
enabling a project also enables its machine. A machine switch therefore admits work
that touches no registered local project. Project switches select where a member may
start work; agents are not sandboxed, so they are not a filesystem isolation boundary.
The whitepaper leaves per-directory isolation to future work.


## Accepted metadata trust boundary

On 2026-11-10 the owner accepted UI-only isolation for honest members. Directly
rewriting synchronized `machineId`, containment or `userId` can defeat visibility
and read routing, including the assignment fallback. The signed grant source does
not authenticate those metadata bindings. This phase adds no authoritative
registry. Stronger isolation needs session-to-machine authority plus server
session-filtered delivery; E2EE members still retain content keys. Personal grants
use `{sessionId, audience: {userId}, level: 'read'}` alongside team audiences and
inherit only the same contained root. Only the machine owner manages either list.

Owner scope decision (2026-11-10): ordinary Roost history supports team and individual read sharing. E2EE workspaces currently do not support Roost and offer no Roost sharing; the storage-unavailable gate remains. Roost is expected to become the default history backend. Future E2EE Roost support must reuse the same session-read authorization and revocable permits, without separate sharing semantics. This scoped admission is not an implementation or acceptance claim for encrypted Roost storage.
