# Store each model's effort and Fast support in its own row

Status: implemented
Translation: current
Language: [中文](2026-09-29-per-model-acp-capability-row.zh.md)

## Abstract

Lody kept one capability entry per agent config, copied from a single `session/new`
response. ACP agents rebuild the reasoning-effort list and the Fast toggle on every
model switch, so that entry described only the model the agent happened to start on.
Other models showed its effort levels and its Fast toggle. A user whose Codex default
was `grok-4.6` lost both controls for every model. The Claude and Codex adapters
already publish every model's controls under `_meta.lody.modelCapabilities`, but the
host never read it. Lody now stores that declaration per model in a separate
`acpModelCapability` machine Flock row, and every reader resolves effort and Fast for
the selected model.

## Problem

- **Stored snapshot**: the `['acpCapability', configId]` row stores `configOptions`
  from one `session/new`, rewritten by each probe and created session. Its effort list
  and Fast option belong to that response's current model.
- **Per-model data today**: `modelReasoningEfforts` came only from Codex's legacy
  `model[effort]` ids and Grok's `_meta.lody.modelReasoningEfforts`. Nothing described
  Fast per model.
- **Workarounds**: the UI, CLI validation and MCP run-config resolution each worked
  around the snapshot separately, for example with a hand-maintained Codex tier table.

## Decision

- **Read**: `readAcpModelCapabilitiesMeta` parses the v1 declaration
  (`{ version: 1, models: { [modelId]: { effortValues?, fastMode? } } }`). An unknown
  version or any malformed model entry discards the whole declaration, so a missing
  model never reads as "unsupported".
- **Store**: `['acpModelCapability', configId]` holds
  `{ version: 1, sourceVersion, models }`.
  - Both writers pass the declaration through `updateAcpCapabilities`: the refresh
    probe and the created-session writeback.
  - The value has no timestamp, so an unchanged declaration costs no write or sync.
  - A response without a declaration leaves the row alone.
  - The capability row and its dedupe comparison are unchanged.
- **Merge on read**: `getMachineFlockAcpCapabilities` attaches the row's models as
  `declaredModelControls` when its `sourceVersion` matches the capability row. It is
  never stored in the capability row. Readers include the family in their Flock reads.
  `MachineDocument` keeps reading the capability row alone: its dedupe compares what
  was written, and it answers the strict `machine/acp-capabilities-refresh_response`
  schema.
- **Use**:
  - UI selectors take the selected model's declared effort list. This also covers
    Codex, where the declaration replaces the hand tiers.
  - UI selectors hide Fast for a model declared without it, and add the built-in Fast
    toggle for a model declared with it that the probe did not show.
  - CLI validation and MCP resolution read effort through
    `getModelEffortChoices` (declaration first).
  - A declared Fast is never a reason to reject a request.
  - Undeclared models keep today's behavior.

## Declaration versus the control the adapter really offers

Review of the first version found three gaps, now closed. A shared built-in binding
(`getBuiltinModelControlBinding`) records each built-in adapter's effort option id and how
it publishes the control. Unknown agents get no binding, and Lody never guesses their
ids.

- **Claude's `default`**: Claude publishes a `default` effort option on top of the
  model's levels. It clears the effort pin and follows the provider's default,
  whenever the client does not negotiate AIR `recommendedValue`, which Lody does not.
  The declaration lists only the levels. `resolveDeclaredEffortSupport` therefore
  adds `default` for Claude and uses it as the fallback value. `getModelEffortChoices`
  gives UI, CLI and MCP the same list, so `effort=default` is never rewritten to
  `medium` or rejected.
- **Missing control**: when the probed model had no effort control, a declared
  model's effort gets the built-in adapter's own control (Claude `effort`, Codex
  `reasoning_effort`).
- **Unsupported versus unknown**:
  - a declared empty list means the model has no effort, and the control is hidden;
  - Claude omits `effortValues` exactly when a model has no effort, so for Claude a
    declared model without them is unsupported;
  - for other adapters an omitted list is unknown and keeps today's behavior.
- **Role across a model switch**: applying a Role filters its values with the
  outgoing model's selectors. When the Role also switches model, effort and Fast
  (`isPerModelControlConfigId`) now pass through even when the outgoing model has no
  such control. The selection resolution then validates them against the incoming
  model, so `fast=true` survives a switch away from a model without Fast.
- **Role editor model switch** ([#1308](https://github.com/LodyAI/Lody/issues/1308)):
  the editor shows the agent's defaults and stores them on the first edit. Defaults
  fill only unset fields, so switching a Claude Code Role from a model with Fast to
  one without kept `fast`, and the composer never matched the Role. Choosing a
  different model now drops only the values whose outgoing selector is effort or
  Fast (`isThoughtLevelSelector`, `isFastModeSelector`), the same set
  `normalizePerModelSelectors` fits per model, and the defaults refill them for the
  incoming model. Plan, permission and other options stay; re-selecting the current
  model changes nothing. A reset of every non-permission option was rejected
  because it also dropped Plan.
- **MCP**:
  - a model declared without Fast rejects `fastMode=true` and treats `false` as a
    no-op;
  - a model declared with Fast that the probe lacked gets the built-in Fast id.

## Limits

- **Stale display**: an account or entitlement change outside Lody is not tracked
  until the next probe or created session brings a new declaration.
- **Concurrent writes**: no write-sequence guard yet, so two concurrent probes of one
  config may land out of order. This affects display only.
- **Old clients**: they ignore the new row family and behave as before.
- **Undeclared Fast in the Role editor**: without a declaration Lody keeps the probed
  selectors, so a new Role on a model that lacks Fast can still store `fast` when
  the probe ran on a model with it. Roles that already store an unsupported value
  are not migrated.

## Verification

- Shared tests cover:
  - parsing the declaration and rejecting it whole when invalid;
  - declaration-first effort resolution;
  - the source-version gate on the merge.
- `machine-document-capabilities.test.ts` checks the write behavior:
  - one write per declaration change;
  - no write when the declaration is unchanged;
  - a missing declaration keeps the stored row.
- `acp-selector-options.test.ts` checks that the selected model's own effort list and
  Fast toggle are shown, and that undeclared models are unchanged.
- Removing each of the three mechanisms (declared effort, Fast normalization, the
  read-time merge) fails its test.
- `agent-role-form.test.ts` covers the Role editor switch: Fast is dropped and effort
  refilled, Plan and permission survive, and re-selecting the model is a no-op.
- Not verified: real adapters end to end.
