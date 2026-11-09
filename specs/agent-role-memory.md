# Agent Role memory providers

Status: draft
Translation: current

[中文](agent-role-memory.zh.md)

## Scenario and ownership

A user chooses a machine in Settings → Memory and manages Lody's saved memory
associations. Add Memory opens an Agent Config-style editor with a provider rail
and Create / Import tabs. Create enrolls an identity and immediately imports it; Import
lists the device's identities with checkboxes for batch import and copies each selected
identity's name and description. Already-linked identities remain visible but cannot be linked again.

Providers own memory data. Lody stores association metadata in the selected
machine's Loro/Flock document at `['memory', providerId, memoryId]`, with machine
ID, name and optional description. Writes use the existing workspace writer;
local durability completes the action and remote upload is best-effort. Stable
keys make linking idempotent without overwriting customized metadata. Editing updates the provider profile via its adapter and synchronizes the returned
name/description into Lody; deleting removes only this association, never provider data.
A failed local save after enrollment can retry linking without enrolling again.
Existing provider identities are not automatically imported.

Cards show a vertically centered grayscale provider logo before the name and description, with edit/delete
actions on hover or keyboard focus. The page has top-right Add Memory and Refresh
actions. A successful provider inventory that omits a saved identity shows a
warning; offline, inactive and failed probes do not prove deletion. Probes run on
entry, focus and every 30 seconds while visible, skipping pending requests.
Memory settings and the Role editor's memory section keep saved cards visible during probing
without a loading indicator; completed failures still show inline status.

The Role editor has Configuration and Team tabs sharing one draft and save
action. Memory belongs to a machine, so it is a section of each machine tab in the
Configuration tab ([machine targets](agent-role-machine-targets.md)). It lists saved
associations on that tab's exact machine, using the same logo/name/description
cards as Memory settings. Clicking a card selects it; unlinking remains available.
Workspace sharing is shown only in the Team tab. Each machine target's run
configuration and turn input still store only `{ providerId, memoryId }`; adding a
target links memory only when that machine has the same association.
Removing a catalog association does not rewrite existing Roles or accepted turns.
Unlinking a Role affects future turns; accepted turns and Operations keep their
frozen configuration. Neither memory contents nor credentials enter the catalog.

## Provider boundary

The daemon owns installed/running detection, identity listing and creation, and
the mapping from an identity to ACP process environment. A provider supplies a
name, installation URL and supported creation fields to the UI. No caller can
supply a command or environment dictionary through the memory RPC.

The initial adapter is Nowledge Mem. It executes `nmem status -j`; a missing
executable shows in-page copy with `https://mem.nowledge.co/en` on that machine's
Memory page (and in the Role memory picker). A successful exit with top-level
status `ok` or `healthy` means ready; other status values ask the user to start
Mem and refresh. Opening Memory still probes the selected
machine automatically. Missing or inactive nmem must not open a dialog. When
ready, `nmem agents list -j` supplies `agentProfiles`. Creation uses
`nmem agents enroll <id> -j` with a required name and optional description, role and default
Space, in the existing settings editor dialog. Enrollment is create-only; an
existing ID keeps its provider profile. The returned list remains authoritative.

Settings reuses the Agents machine selector: line tabs in the desktop pane when
more than one machine is visible, pills outside the pane, and no remote selector
on local-only platforms. The selected machine's saved associations use the same catalog
rows as Agents. The Role editor's memory section reuses the association cards, status copy and install link. Offline machines and daemons without
`memoryProviders` v1 do not receive memory RPCs. Requests use the existing
local/remote machine routing; a failed local request never falls back to a
remote transport.

## Execution

Role selection freezes the reference into the user turn and accepted create
Operation. Preparation compatibility includes it. ACP startup resolves the
adapter and injects `NMEM_AGENT_ID=<memoryId>` for Nowledge Mem after environment
assembly. Changing identities between turns restarts the ACP process through the
existing resume path; the environment of a live process cannot be changed.
Forks and restores use their frozen history rather than rereading a mutable Role.
Unknown providers fail explicitly. Other provider integrations and automatic
installation/configuration of agent-side Mem plugins are outside this change.

## Evidence

- [Provider contract](../packages/shared/src/memory-provider.ts)
- [Daemon adapter](../apps/cli/src/lib/memory-providers.ts)
- [Settings](../packages/components/src/components/settings/memory-setting.tsx)
- [Process boundary](../apps/cli/src/session/session.ts)

The memory editor is window-centered, with a compact 900 × 600 px desktop size
clamped to 96dvw × 92dvh.
Creation requires a non-blank Name and places Name and Agent ID on one row, in that order. Until manually edited,
the ID follows the lowercase name. Space is hidden and omitted by default. Nowledge
enrollment fixes source-app to lody.ai. Link rows show only name and description, including after selection. No expanded
profile details are requested or displayed.

The provider rail uses the same flat selected list rows as Agent Config, including
when only one provider exists. Import is the settings label for saving an association;
Role binding continues to use Link.

Machine tabs show online status dots and default to the local machine. The Nowledge
edit form mirrors creation with a read-only ID and editable name, description and
role. It calls nmem agents set; blank editable fields are explicitly cleared, while
hidden Space and provenance fields are preserved. Failed provider updates never
claim a successful local metadata save.

A memory with no binding in the accessible Role catalog shows a Link to a role
action before edit/delete, once the catalog is loaded. It opens Agent Roles,
scrolls to the first Role running on that machine and opens Roles on that machine's
tab; new Roles preselect that machine. The action does not mutate a Role or
auto-select an identity. The Role page has no machine tabs or machine filtering.

Assigned memories show “Linked:” followed by the accessible bound Roles’ emoji avatars.
Desktop hover/focus reveals the Role name; mobile tapping opens a name popover.
Assignments match any of a Role's machine targets by machine, provider and memory ID, and update with the Role catalog.

## Proposed built-in memory (Lody Memory)

### Requirements and scope

A user creates a named memory, links it to a Role, and lets the Agent read and
update it through Lody tools across turns and devices. Reliable Agent tool updates
are the first priority; compatibility with every external editor's save strategy
is not a prerequisite for that tool path. Lody Memory belongs to a person or
workspace and appears above machine tabs. External providers above retain their
machine-scoped behavior under "Integrated providers".

The following requirements are established:

- Store Markdown files in Lody-hosted Drive9. The unreleased Loro implementation
  requires no data migration or backward compatibility.
- Support private and shared memories with mutable visibility. Private content is
  accessible only to its owner through the daemon and is never mounted. Shared
  content is read-write for all workspace members.
- Accept online-only operation and plaintext hosted content without memory E2EE.
  The local-only OSS desktop has no Lody Memory.
- Prioritize reliable Agent tool reads and updates. Conflicting writes must be
  reported rather than blindly overwriting a newer revision.
- Provide provenance for current memory content. Restorable old versions, undo,
  and a complete historical audit trail are not required.
- Normal credential renewal must not interrupt a mounted memory, invalidate open
  handles, or lose in-flight writes. Unmount/remount is not an acceptable renewal
  strategy. Explicit access revocation must still stop subsequent access.

Shared mounting remains the target. Whether its delivery must coincide with the
first usable Agent-tool milestone is an open release-scope decision. Real-time
cross-device refresh is proposed for deferral, not yet an approved requirement.

### Current proposed design

Each workspace has one Drive9 tenant; each memory occupies
`/memories/<memoryId>/`. Relative paths identify documents. `MEMORY.md` contains
name and description in front matter and serves as the entry document; further
Markdown files contain topics. Visibility is catalog metadata, so changing it does
not move files. Rename does not silently overwrite an existing destination.

A Role binds `{providerId: "lody", memoryId}`; multiple Roles can share a memory.
The binding is frozen for each turn. Model input cannot select a different memory
or supply credentials. A frozen binding does not preserve revoked authorization.
Unlinking a Role affects future turns without deleting content; deleting a memory
removes its files. Previously disclosed conversation context cannot be erased.

```text
Lody clients (desktop / Web / mobile)
              | daemon RPC
              v
Daemon: turn-bound tools, prompt context, MemoryBackend
              | memory-scoped filesystem token
              v
Drive9: /memories/<memoryId>/ Markdown files

Hosted Lody service: identity, membership, visibility, scoped token issuance
Shared mount: additional access path; noninterrupting renewal required
```

The daemon owns the Drive9 SDK and serves reads, searches and updates through the
existing memory tool/RPC boundaries. Before modifying a file, it obtains the
current revision and submits a conditional write; conflicts return to the Agent
for rereading and deliberate reconciliation. Reads/searches stay under the bound
memory prefix. `MemoryBackend` separates this storage from the existing consumers;
history-related surfaces must be adjusted rather than pretending Drive9 supports
old recovery contracts. Compatible daemons advertise `builtinMemory: 2`.

A hosted service holds tenant owner keys, verifies identity and current access,
and issues short-lived filesystem tokens restricted to the memory path. Public
code accesses it through `packages/platform` ports and `packages/cloud-api` DTOs.
Owner keys never reach devices. Filesystem tokens use `DRIVE9_API_KEY`, not
`DRIVE9_VAULT_TOKEN`; credentials must not be persisted in CLI config or mount
state. Tokens may live in the daemon and mount process memory.

Shared mounts target `~/Lody/Memory/<name>`. They are outside Role authorization:
other programs running as that user can access them. Private-to-shared grants
members access; shared-to-private revokes member tokens and unmounts on online
devices. Already disclosed or cached copies cannot be recalled; the UI explains
this before confirmation. This intentional revocation is distinct from renewal.

The proposed initial freshness model reads current content when opening or using
memory, and refreshes the local view after a successful tool update. Other devices
refresh on their next read or explicit refresh; no immediate notification is
promised. This avoids an SSE dependency: at the tested pin, filesystem tokens
cannot subscribe to events, while owner SSE covers the whole tenant. A scoped
relay or upstream event authorization is only needed if live refresh becomes a
requirement; neither is selected for the initial implementation.

### Current-content provenance

The proposed first unit of provenance is a file's current revision, not each
sentence or fact. A Lody Agent update associates memory ID, path, revision (or
content hash), user ID, machine ID, session ID, turn ID, tool-call/change ID, and
service-confirmed time. Identity comes from authenticated context; a caller's
arbitrary actor label is not proof of identity. Session links remain subject to
session access control and must not expose private conversation content to shared
memory readers.

The source record must match the content being displayed. A stale record must
never attribute new content to a previous writer. A file update followed by a
separate provenance append can fail between steps; the implementation design must
specify idempotent reconciliation, retry behavior and an explicit incomplete
result. It must not report both content and provenance complete when only the
content was saved. The storage/commit mechanism is still unresolved; no journal
atomicity is assumed, and filesystem tokens cannot append Drive9 journals.

For external mounted edits, Lody cannot infer an Agent session or turn. The
proposal is to show only authenticated user/device information when available,
and otherwise mark the current version as external/unknown. Whether that fallback
is acceptable requires confirmation. A later external edit must invalidate an old
Agent attribution when the current content is next read. No old document bodies
need be retained solely to provide this current-version attribution.

### Implementation plan and acceptance

| Stage | Deliverable | Acceptance boundary |
| --- | --- | --- |
| 1. Contracts | Resolve the scope questions below; define backend DTOs, current-version provenance states, access checks and credential lifecycle. | No owner-key distribution, no implicit history promises, explicit incomplete-write and conflict results. |
| 2. Agent tool path | Implement hosted credential port and Drive9 backend for create, list, read, search, update, rename and delete; connect Role-bound tools and client RPC. | Agent updates are visible on subsequent reads; sibling-memory access is denied; stale revisions conflict; revoked access fails. |
| 3. Provenance and UI | Implement current-content source records and reconciliation; expose memory management, visibility and source viewing. | The displayed source matches current content; interrupted provenance writes cannot show stale attribution or false success; private sessions remain protected. |
| 4. Shared mounts | Package/manage Drive9 and implement credential hot rotation without unmounting. Investigate external-editor atomic replacement separately from tool writes. | Normal renewal preserves mount, open handles and in-flight operations; revocation blocks new server access; credentials stay out of persistent state. |
| 5. Release verification | Validate supported platforms, private/shared access transitions, multi-device reads, tool conflicts and hosted limits. | The chosen release scope passes its behavioral checks; quotas and failure behavior are defined. No offline, history-recovery or universal editor-compatibility claims. |

Stages 2 and 3 can be developed before mount compatibility is complete. Shipping
without stage 4 requires the release-scope decision below; incomplete mount renewal
must not be presented as supported. Hosted price, quota and provisioning behavior
still require investigation, not assumptions from local TiDB measurements.

### Questions requiring product decisions

1. May the first release provide Agent tools while shared mounting follows later,
   or must the first release include both? Tool-first priority alone does not
   settle mount delivery timing.
2. Does provenance mean the last update of each current Markdown file, with a link
   to its session/turn, or the source of each fact/passage? The latter needs
   finer-grained content/source associations and is outside the current proposal.
3. For external mounted changes, is external/unknown provenance acceptable when
   authenticated user/device attribution cannot be established?

Unless changed during review, the proposed design defers live SSE refresh,
recoverable history, read-only member roles and user-supplied Drive9 endpoints.
Only the absence of a historical recovery requirement is already established;
the other deferrals are proposed scope choices.

### Evidence and implementation status

P1 verified scoped file access, basic English/Chinese search, conditional-write
conflicts, rejection of new requests after revocation, and basic macOS mounted
read/write. Atomic replacement over an existing mounted file returned `EINVAL`;
its exact failing layer is not established. Mount clients retain their initial
credential, scoped SSE/journals are unavailable, and journal entries alone do not
restore old file contents. These are findings, not completed Lody integration.

The [Drive9 proposal](../.agents/notes/proposed/architecture/2026-11-09-lody-memory-drive9.md)
contains pinned evidence and verification limits. The current
[package](../packages/memory/README.md) still implements the
[rejected Loro design](../.agents/notes/rejected/architecture/2026-10-26-builtin-personal-memory.md).
This specification remains draft; confirmed requirements do not imply approval of
the proposed implementation or unresolved release scope.
