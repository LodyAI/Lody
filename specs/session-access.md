# Team access to one conversation

Status: draft
Translation: current

[中文](session-access.zh.md)

A machine owner can share one conversation for team reading while keeping the
machine private. Teammates can read the full conversation and reference it from
their own sessions. They cannot send input, run commands or manage the shared
conversation. Ordinary and encrypted workspaces use the same controls and rules.

## Authority and effective access

Permissions never live in mutable CRDT SessionMeta. The owner of the machine
named by the conversation's current `machineId` manages sharing; its assigned
`userId` grants nothing. An authorization for a different machine does not apply.
Contained child Tabs and Side Chats inherit the root's grant only on that same
machine; opened independent Sessions do not inherit it.

| Current authority | Effective access |
| --- | --- |
| Machine owner | Manage and edit; always visible |
| Shared machine and, for a local project, shared project | Edit, as before |
| Explicit root-session read grant on the matching machine | Read only |
| None | Hidden |

A read grant never enables machine/project sharing or execution. This phase cannot
make one conversation private inside an otherwise shared machine/project.

## Storage and trust

Ordinary workspaces store `readSharedSessionIds` on the authoritative machine row.
Only its owner may mutate the set after current workspace membership checks.
Convex subscriptions publish changes. Public source owns only DTOs and capability
gated calls; backend handlers belong to the private composition.

Encrypted workspaces store `sessions: [{sessionId, level: 'read'}]` in the complete
machine-owner-signed v3 policy. A `session` change grants or removes that one ID
without changing the machine/project switches. The format is current-only: no
older-format reader, migration or reset script. E2EE has no production data.
Compatible backend admission must deploy before clients; older clients reject v3.
The membership ledger format remains unchanged.

Only the latest original needs verification: decrypt, verify the currently active
owner-personal signer, check resource/binding/generation, and compare the local
high-water pin. Lower revisions and differing digests at an equal revision fail;
missing intermediate revisions do not matter. Parent digests order server CAS
writes. Revoking an issuer invalidates its policy; another active owner device
shares again from private defaults, without inheriting revoked grants.

A subscribable encrypted query exposes only machine/generation/version hints.
Hints trigger a host policy reread; opening a deep link also forces a reread.
Hints never grant authority. Withdrawal retains the existing receiving-machine
freshness window and trust limits in the [machine-sharing Spec](e2ee/machine-sharing.md).
Execution still requires machine/project authorization. CLI/MCP history reads may
accept a matching session read grant without granting execution.

Encrypted private-machine conversations are hidden from other members unless
shared at machine/project or session level. **This is interface hiding, not
cryptographic privacy:** members still hold content keys and can recover content
outside this interface. It is not a server room-filtering or per-session-key design.

## Read-only interface

The header shows Private / Team read-only / Team can edit. Its Team access panel
offers Private and Team read-only. Effective machine/project sharing explains why
editing is enabled and links to machine settings. Other members see the same panel
with disabled controls and an ownership explanation. Public-link publication remains
separate and retains its existing consent and authorization.

The read-only page replaces the composer with “Read-only · Runs on X” and a
“Reference in a new session” action that prefills a real session mention. It retains
pinning, mark unread, Markdown copy and references. It exposes no Stop, Steer,
queue, approval/question replies, run/Role controls, rename/archive/owner/sharing
mutations, file saves, terminal input, Commit/Push, or browser/simulator previews.
Lists on desktop and mobile show read-only markers; management commands recheck
current access rather than trusting retained UI callbacks.

## Current acceptance gap

The experimental machine-owned Roost history format currently requires machine
RPC access; the document-only reader supports workspace-synced Loro history.
Session-only Roost RPC authorization is unresolved. This does not relax the full
conversation requirement above: do not claim complete acceptance for Roost until
the owner resolves this scope and its read boundary is implemented and tested.

## Later phases and evidence

Writable sharing and individual invitations, server filtering by room, and
per-session keys require separate review. This draft is not human approval or a
claim of deployed, native or two-member product acceptance.

Owners: [platform port](../packages/platform/src/session-access.ts),
[policy](../packages/e2ee-core/src/internal/machine-sharing.ts),
[visibility](../packages/components/src/lib/session-visibility.ts),
[decision note](../.agents/notes/proposed/architecture/2026-10-28-e2ee-machine-sharing.md).
