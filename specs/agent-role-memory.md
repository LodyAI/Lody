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

The machine-scoped association/environment behavior above continues to describe
external providers such as Nowledge, grouped as "Integrated providers". The proposed
Lody Memory provider sits above the machine tabs because it belongs to a person or
workspace, not a machine. A workspace member creates named memories; name and
description are the front matter of that memory's `MEMORY.md`. A Role links one
memory by `{providerId: "lody", memoryId}`; several Roles may share it.

Each memory is a directory of Markdown files in the workspace's hosted
[drive9](https://drive9.ai/) tenant, at `/memories/<memoryId>/`. Relative paths are
document identity. A memory is **private** or **shared**, and the owner may change
this after creation:

- **Private:** only the owner's daemon reads and writes it through the drive9 SDK,
  for MCP tools, prompt injection and daemon RPC (Renderer, Web, mobile). It is
  never mounted on disk.
- **Shared:** every workspace member gets read-write access. Their daemons also
  mount it at `~/Lody/Memory/<name>` for ordinary file tools. A mount is outside
  Role authorization, which is why private memories are not mounted.

Switching shared → private revokes member access and unmounts on online devices;
content members already read or cached cannot be recalled, and the UI says so first.

Memory content is plaintext on the hosted service; no E2EE applies, and Lody Memory
requires a connection. Credentials are short-lived tokens scoped to one memory's
path, issued by a hosted service through an injected platform port and held only in
daemon memory. Model inputs cannot choose another memory: tools receive only the
turn-frozen binding's token. The OSS local-only desktop has no Lody Memory.

Writes record provenance: Agent writes carry user, session and turn and use
revision checks; writes through a mount are attributed to user and machine only,
and concurrent mount writes are last-write-wins with the journal as recovery.
Unlinking or deleting a Role revokes later Agent access without destroying
content; deleting a memory removes its files. Previously disclosed conversation
context is not erased. Linking requires a daemon advertising `builtinMemory: 2`.

Rationale, alternatives, open questions and the verification required before
implementation are in the [drive9 proposal](../.agents/notes/proposed/architecture/2026-11-09-lody-memory-drive9.md).
The current [package](../packages/memory/README.md) still implements the
[rejected Loro design](../.agents/notes/rejected/architecture/2026-10-26-builtin-personal-memory.md).
This contract remains draft.
