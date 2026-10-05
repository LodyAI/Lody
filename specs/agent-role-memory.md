# Agent Role memory providers

Status: draft
Translation: current

[中文](agent-role-memory.zh.md)

## Scenario and ownership

A user chooses a machine in Settings → Memory and manages Lody's saved memory
associations. Add Memory opens an Agent Config-style editor with a provider rail
and Create / Import tabs. Create enrolls an identity and immediately imports it; Import
lists the device's identities with single selection and copies its name and
description. Already-linked identities remain visible but cannot be linked again.

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
Memory settings and the Role Memory tab keep saved cards visible during probing
without a loading indicator; completed failures still show inline status.

The Role editor has Configuration and Memory tabs sharing one draft and save
action. The Memory tab lists saved associations on the Role's exact machine,
using the same logo/name/description cards as Memory settings. Clicking a card
selects it; unlinking remains available. There is no inline Memory section in
the Configuration tab. Role run configuration and turn input still store only
`{ providerId, memoryId }`; changing the Role's machine clears its reference.
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
Memory page (and in the Role memory picker), and a status other than `ok` asks
the user to start Mem and refresh. Opening Memory still probes the selected
machine automatically. Missing or inactive nmem must not open a dialog. When
ready, `nmem agents list -j` supplies `agentProfiles`. Creation uses
`nmem agents enroll <id> -j` with a required name and optional description, role and default
Space, in the existing settings editor dialog. Enrollment is create-only; an
existing ID keeps its provider profile. The returned list remains authoritative.

Settings reuses the Agents machine selector: line tabs in the desktop pane when
more than one machine is visible, pills outside the pane, and no remote selector
on local-only platforms. The selected machine's saved associations use the same catalog
rows as Agents. The Role editor Memory tab reuses the association cards, status copy and install link. Offline machines and daemons without
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
action before edit/delete, once the catalog is loaded. It opens Agent Roles
showing all machine groups and scrolls to the target group; new Roles preselect that machine. The action does
not mutate a Role or auto-select an identity. The Role page has no machine tabs or machine filtering.

Assigned memories show “Linked:” followed by the accessible bound Roles’ emoji avatars.
Desktop hover/focus reveals the Role name; mobile tapping opens a name popover.
Assignments match machine, provider and memory ID, and update with the Role catalog.
