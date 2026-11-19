# Workspace full export and import

Status: draft
Translation: current

[中文](workspace-export-import.zh.md)

A workspace owner wants to back up a whole workspace and merge it back after changing
device or storage, and Lody must move data from the old loro-repo storage into native
loro-repo-rs. The human-readable `lody export` drops deletion records, clocks and peers,
and `lody migrate --from-oss` only goes from local OSS to cloud. This Spec defines a
lossless, verifiable, mergeable workspace bundle shared by backup, device change and
storage migration.

## Owner decisions

Confirmed by the owner on 2026-11-19; this document does not reopen them.

1. Only workspace owners and admins may export or import.
2. An encrypted (E2EE) workspace exports a plaintext bundle, decrypted locally by an
   authorized member device.
3. Import merges into an existing workspace, not only an empty one.
4. "Full" covers only data the exporter can read; the rest is recorded as gaps.
5. The bundle format does not depend on whether the source was encrypted, and any
   bundle imports into either kind of workspace without extra confirmation.
6. The bundle has no passphrase encryption.
7. Machine configuration is not imported across workspaces.
8. Roost conversations are exported without signatures and rewritten on import.
9. Prompt Shortcuts are in the first version.
10. A same-ID session never overwrites the target; it is skipped or copied.
11. A cross-workspace import fences imported sessions and schedules in the target
    instead of rewriting them.
12. Imported conversations are shared: every member of the target workspace can read
    them, and nobody can edit them.

Items labelled recommendation or inference below are not owner decisions.

## What is exported

"Full" means every room of collaborative workspace data the exporter may read:
workspace Meta, the workspace catalog (projects, MCP definitions, Roles), session and
schedule documents with their registries, machine catalogs, Preview and legacy
comments, legacy task documents, Roost turns (lossy), attachment blobs and Prompt
Shortcuts. Rebuildable indexes (file index FI/FIS), transient channels, machine-local
runtime state, unsent drafts and cloud service records (usage, members, sharing) are
not exported.

Credentials, keys, device identities, ledger, members, roles, invitations and billing
are never exported. Anything the exporter cannot read is recorded in the manifest as a
gap with its reason and shown as "this bundle is incomplete"; nothing is skipped
silently.

## Bundle format

A `.lodybundle` is a ZIP64 file with stored entries: raw room bytes in chunks of at
most 64 MiB, blobs named by SHA-256, and `manifest.json` written last. The manifest
records the source workspace and exporter, each room's codec, encoding, version and
chunk hashes, blobs, gaps and a digest of itself. A higher major version is rejected.

- **Lossless:** rooms hold only raw SDK bytes (`Flock.exportFile()`, complete Loro
  snapshots), so deletion records, clocks, peers and unknown fields survive. Rebuilding
  through scan/put or JSON is forbidden.
- **Consistency:** each room is a complete state of itself; Meta is read first and
  rooms created later are not included.
- **Integrity, not authenticity:** hashes detect corruption and truncation. An
  owner/admin can forge plaintext anyway; safety comes from authorization at import.
- **Protection:** the file is written only where the user chose, created 0600 and
  published atomically, and never uploaded. Export warns that anyone holding it can
  read every conversation.

## Import

1. **Verify** every hash; any failure leaves the target untouched.
2. **Admit:** check the importer's role and that every codec is known; an unknown codec
   rejects the whole bundle.
3. **Dry run** on detached copies and report additions, updates, skipped rooms with
   reasons and gaps. Nothing is written until the user confirms.
4. **Write** bodies, then catalogs, then Meta, so titles appear only once their bodies
   exist. An interrupted import on today's storage may briefly show untitled rows until
   it is rerun.
5. **Finish** with a visible import receipt in the target workspace.

Merging is ordinary CRDT merge, as if two offline devices reconnected. A newer target
deletion wins and is not resurrected; a newer deletion in the bundle deletes target
data, and the dry run lists it. Inputs already executed never become pending again.

**Same-ID sessions (recommendation):** if both documents share a peer in their version
vectors they have one origin, such as a restore, and merge normally. Otherwise the
session is skipped with its Meta, comments and attachments, and listed by title. A
conflict copy was not chosen because a new ID ripples through every reference and
breaks idempotency.

**Recovery:** a journal keyed by bundle room id lets a rerun of the same bundle
continue; reimporting merged rooms is a no-op. There is no rollback, because merged
CRDT data cannot be withdrawn; completing the import is the recovery. Import completes
when the target is locally durable, and upload is retried by normal sync.

### Into another workspace

Entity IDs, peers and user IDs are kept. Room ids that embed the workspace id are
mapped to the target. Machine rooms stay behind, so imported sessions show their
original machine as unavailable. Per-machine schedule run rows stay behind as well.

Imported sessions and schedules are not rewritten. Their metadata gets an import fence
naming the target workspace, listing the user input, queued items and schedule
activation from the bundle. Execution in that workspace skips exactly those; new
messages and schedules resumed there run normally. Other workspaces ignore the fence,
so a bundle taken back to the source does not stop its originals.

Existing visibility requires the conversation's machine to be visible, or the reader to
own it, and imports meet neither. Imported conversations are therefore shared (decision
12): every member of the fenced workspace reads them and no other workspace gains
access. Conversations that were private in the source become readable to the whole
target; only an owner or admin can import, and only what they could read. The fence
records the importer as provenance.

### Into an E2EE workspace

Import runs on an admitted owner/admin device. Writes go through its protected
namespace, resealed with the target's current epoch key; attachments get fresh file
keys. Signed execution intents in the bundle fail verification and never run, and the
importer never re-signs them. Ledger, members, devices and sharing policies are
outside the bundle.

## Authorization

The local OSS desktop's single user is the owner; cloud workspaces use the member role,
and E2EE workspaces the role in the verified ledger. Export only reads what the
exporter can already sync, so its role check is product policy plus audit. Import's
real defense is per-row validation: an existing target row changes only where the
importer could change it through the ordinary product rules (Roles, machine rows,
sharing grants). One violation rejects the whole room, because raw Flock bytes cannot
be merged partially. Both recheck the role before each room and stop on revocation.

The cloud composition registers each export and import for audit, without bodies. The
local OSS composition makes no cloud requests.

## Entry points

- CLI: `lody workspace export --out <file>` and
  `lody workspace import <file> [--dry-run] [--yes]`; the dry-run report is confirmed
  unless `--yes` is given.
- Desktop: Settings → Data, for owners and admins: export through a save dialog, import
  through an open dialog, a review of the dry run, then the merge.
- The work runs on the Node side (one-shot CLI or local daemon); the renderer sees only
  results, never the import file path.

## Native migration

Old storage to native is the same pipeline with a `legacy-repo` source adapter and the
native workspace as target; it need not write a file. A source with unuploaded edits is
enqueued for upload as the original writer. Format changes, such as Preview comments
moving to Flock rows, are codec conversions; the bundle keeps the original format.
`lody migrate --from-oss` stays until this pipeline covers its checks.

## Roost and Prompt Shortcuts

**Roost:** each turn is signed by the executing machine and the SDK cannot export the
signed records, so export reads visible turns and import writes them as the session's
Loro history, switching its backend to Loro. Signatures and edit steps are lost; visible
content is kept. Rewritten turns never merge into a session the target already has
(recommendation).

**Prompt Shortcuts (inferred from the owner's privacy principle):** export includes
the exporter's own Shortcuts and others' shared ones. A private item is imported only
for its original owner and stays private; a shared item becomes a shared item owned by
the importer, noting the original author. Encrypted workspaces record Shortcuts as gaps.

## Not implemented yet

Prompt Shortcuts, relay-hosted attachments and images (recorded as gaps), cloud audit
registration, verified-ledger role checks for E2EE (the workspace summary role is
used), and the native source and target adapters.

## Evidence

- Intent: decisions 1–11 confirmed by the owner on 2026-11-19, decision 12 on the same
  day. This revision as a whole is not approved.
- Inspected: [`lody export`](../apps/cli/src/commands/export.ts),
  [OSS migration](../apps/cli/src/lib/oss-migration/README.md),
  [E2EE room mapping](../packages/shared/src/workspace-streams-content.ts),
  [session access](session-access.md), [E2EE foundations](e2ee-foundations.md);
  loro-repo `795bafcb` raw export/import types.
- Implementation: [workspace-bundle](../apps/cli/src/lib/workspace-bundle/AGENTS.md).
- Executed: real-repo unit tests there; an end-to-end local run with two daemons
  (export, dry run, import, idempotent reimport, reverse import); the desktop Settings →
  Data flow in the built OSS app. Cloud and E2EE workspaces were not run end to end.
