# Agent Role memory providers

Status: draft
Translation: current

[中文](agent-role-memory.zh.md)

## Scenario and ownership

A user chooses a machine in Settings → Memory, inspects its memory identities,
and creates one when needed. They expand Memory in a Role editor and select an
identity on that Role's exact target machine. Unlinking changes future turns;
already accepted turns and Operations retain their frozen configuration.

Providers own their memory data. Lody stores only `{ providerId, memoryId }` in
Role run configuration and turn input, with the Role's existing machine binding.
The reference is not a credential. Workspace visibility does not make memory
contents part of the workspace catalog. Changing the Role's machine clears its
memory reference in the editor.

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
on local-only platforms. The selected machine's provider is a catalog section
with Refresh and Create controls and an empty-state Create action. The Role
editor keeps Memory collapsed until expanded, then uses the same identity list,
status copy, and install link. Offline machines and daemons without
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
