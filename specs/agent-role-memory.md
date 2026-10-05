# Agent Role memory providers

Status: draft
Translation: current

[中文](agent-role-memory.zh.md)

## Scenario and ownership

A user chooses a machine in Settings → Memory and manages Lody's saved memory
associations. Add Memory opens an Agent Config-style editor with a provider rail
and Create / Link tabs. Create enrolls an identity and immediately links it; Link
lists the device's identities with single selection and copies its name and
description. Already-linked identities remain visible but cannot be linked again.

Providers own memory data. Lody stores association metadata in the selected
machine's Loro/Flock document at `['memory', providerId, memoryId]`, with machine
ID, name and optional description. Writes use the existing workspace writer;
local durability completes the action and remote upload is best-effort. Stable
keys make linking idempotent without overwriting customized metadata. Editing
changes Lody metadata; deleting removes only this association, never provider data.
A failed local save after enrollment can retry linking without enrolling again.
Existing provider identities are not automatically imported.

Cards show the name, grayscale provider logo and description, with edit/delete
actions on hover or keyboard focus. The page has top-right Add Memory and Refresh
actions. A successful provider inventory that omits a saved identity shows a
warning; offline, inactive and failed probes do not prove deletion. Probes run on
entry, focus and every 30 seconds while visible, skipping pending requests.

The collapsed Role memory picker lists saved associations on the Role's exact
machine. Role run configuration and turn input still store only
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
`nmem agents enroll <id> -j` with optional name, description, role and default
Space, in the existing settings editor dialog. Enrollment is create-only; an
existing ID keeps its provider profile. The returned list remains authoritative.

Settings reuses the Agents machine selector: line tabs in the desktop pane when
more than one machine is visible, pills outside the pane, and no remote selector
on local-only platforms. The selected machine's saved associations use the same catalog
rows as Agents. The Role editor keeps Memory collapsed until expanded and reuses
the association cards, status copy and install link. Offline machines and daemons without
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
