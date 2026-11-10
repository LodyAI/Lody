# Access to one conversation

Status: draft
Translation: current

[中文](session-access.zh.md)

A machine owner can share one conversation for team or selected-member reading
while keeping the machine private. Recipients can read its full Loro or Roost
history and reference it from their own conversations. They cannot send input,
execute work or manage that conversation. Both workspace modes use the same rules.
Owner decisions of 2026-11-10 are pending approval of this draft in PR #2487.

## Authority and effective access

Only the owner of the machine named by current `SessionMeta.machineId` manages
sharing. Assignment through `SessionMeta.userId` supplies a read-only visibility
fallback, never management or execution. Ownership transfer still requires the
recipient to have machine/project access.

Effective access is the maximum of these sources:

| Source | Access |
| --- | --- |
| Machine owner | Manage and edit; always visible |
| Shared machine and, for a local project, shared project | Edit |
| Matching team or personal session read grant | Read only |
| Assigned session owner | Read only, unless machine/project access permits editing |
| None | Hidden |

Grants apply only when their machine equals current Meta's machine. Only direct,
same-machine contained Tabs and Side Chats inherit the root's grant. Missing
`childSessionPlacement` means Tab; `side-panel` means Side Chat. Unknown placements,
nested parents and opener-only provenance do not inherit. Team and personal grants
coexist and revoking one does not remove the other. A session read grant never
opens the machine/project execution switches. This phase cannot hide an individual
conversation inside an otherwise editable shared machine/project.

## Storage and read admission

Ordinary machine rows hold the team session ID set and explicit
`{sessionId, userId}` read grants. Only the current machine owner may mutate them;
selected recipients must be current workspace members. Convex subscriptions carry
changes. Public code owns DTOs and capability-gated platform calls; private #4253
owns backend handlers.

Encrypted owner-signed v3 policies hold
`sessions: [{sessionId, audience: 'team' | {userId}, level: 'read'}]` independently of
machine/project switches. IDs are bounded, entries are canonical and duplicate
session/audience pairs fail. Only read is supported; later write access requires a
new reviewed contract. The format is current-only, with no old reader, migration or
reset script. E2EE has no production data; old clients reject the new shape.
The membership ledger format is unchanged.

Verify only the latest original: decrypt, verify the historical owner-personal
signer and resource/binding/generation, and compare local pins. Lower revisions and
differing digests at an equal revision fail; missing intermediate policies do not
matter. Parent digests order server CAS writes. A service-accepted policy remains
effective after its signer is revoked. Settings and affected machine cards show a
nonblocking review reminder; a current personal device can re-sign the full current
machine/project/session list unchanged, or edit it first. This depends on trusting
the service to reject revoked signers at commit time and not withhold newer heads.
Guest, recovery and machine devices cannot sign sharing policies.

Encrypted version subscriptions are invalidation hints, never authority; deep links
also force a policy reread. Receiving-machine execution authorization is unchanged.
Roost history reads use a separate exact-session admission: ordinary requests relay
a short-lived, purpose-bound proof; the serving machine checks current membership
and actual target metadata online. CLI proofs bind the credential account, declared
requester and source machine. Both accounts must have the target read/edit permission,
and the requester must still be able to use the account-owned source machine; encrypted requests use the verified device
and v3 policy. Contained children resolve the same root. Long polls recheck before waiting, after waking and before sending, including
after body reads and response encryption. Encrypted reads retain a ledger-generation
and verified-policy fence through the entire response; observed withdrawal drops the reply. Read admission grants no writes, execution, file or
terminal methods, or other sessions. Ordinary history writes require a separate
editing proof. An offline/unavailable machine produces an explicit reading-unavailable
state. Loro history retains its document reader.

## Interface

The header shows Private / Team read-only / Team can edit; with only personal
grants it shows Shared with N people. Team access offers Private and Team read-only.
Machine sharing explains editing and links to settings. A Members section always
includes the assigned owner, marked owner and not removable, and explicit read-only
recipients. The machine owner can add workspace members and remove explicit grants,
even while team reading is on. Nonowners see the same list and disabled controls.
Public links keep separate publication consent and authorization.

The read-only page replaces its composer with a machine-labelled banner and
Reference in a new session, which prefills a real session mention. It retains
pinning, mark unread, Markdown copy and references. It exposes no Stop, Steer,
queue, approval/question replies, run/Role controls, rename/archive/owner/sharing
mutations, file saves, terminal input, Commit/Push or browser/simulator previews.
Desktop and mobile lists show read-only markers. Management callbacks recheck current
editing authority before writing; assignment/read grants do not pass that guard.

## Accepted trust boundary and later phases

**This prevents accidental interface exposure for honest members; it does not
isolate malicious members who directly edit synchronized data.** `machineId`,
containment and `userId` are mutable CRDT metadata. A malicious member can forge
those fields and defeat these visibility/read-routing rules, including the assigned-owner
fallback. Owner accepted that boundary on 2026-11-10; there is no authoritative
session-to-machine registry in this phase.

**E2EE privacy is interface hiding, not cryptographic privacy.** Members retain
workspace content keys and may recover content outside this interface. Stronger
isolation needs authoritative session-to-machine registration plus server filtering
by session; per-session keys remain a later phase. Writable sharing and other
invitation semantics require separate review.

## Evidence and rollout

Owners: [platform port](../packages/platform/src/session-access.ts),
[policy](../packages/e2ee-core/src/internal/machine-sharing.ts),
[visibility](../packages/components/src/lib/session-visibility.ts),
[decision note](../.agents/notes/proposed/architecture/2026-10-28-e2ee-machine-sharing.md).

**Implementation gap pending owner scope confirmation:** the encrypted workspace currently rejects Roost storage in the CLI document manager and send-admission gate. The scoped read RPC alone does not implement encrypted Roost storage/reading. Until that backend is supplied, E2EE Roost history is unavailable and the full Roost requirement is unfulfilled.

Rollout: merge backend #4253 (automatically deploys staging), run a two-account
product check, merge #2487, then the owner deploys production. Local-only composition
makes no product-cloud calls. Automated suites do not establish deployed,
two-account or native-device acceptance; this Spec remains draft.
