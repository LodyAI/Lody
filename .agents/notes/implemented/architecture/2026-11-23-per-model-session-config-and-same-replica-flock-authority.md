# Scope model-dependent options per model and confirm local Machine Flock reads on demand

Status: implemented
Translation: current
Language: [中文](2026-11-23-per-model-session-config-and-same-replica-flock-authority.zh.md)

## Abstract

Three coupled assumptions caused sub-session creation failures and cross-model UI leaks:
same-replica Machine Flock reads skipped remote confirmation while hardcoding
`confirmed: false`, Role authoring and session defaults stored `thought_level` and
`fast-mode` (`normal` / `fast` / `ultrafast`) flat per provider instead of per model,
and custom or registry ACP agents never recorded per-model option lists unless actively
probed. Same-replica `acpCapability` reads now trust the single-writer local daemon
immediately (`confirmed: true`) and sync only on a local miss, while multi-writer
`agentConfig` and `localProject` reads check the local replica first and run remote
confirmation only on a miss. Live ACP model switches and `config_option_update`
notifications passively record observed per-model options into `mf:<machineId>`, Role
authoring refuses to pin borrowed model-dependent defaults, and session defaults and
composer drafts scope `thought_level` and `fast-mode` under `modelId`.

## Problem

- **Unconfirmed local capability reads**: `session.ts` skipped `syncFlockDocOrThrow`
  when `daemonTarget.sameReplica` was true so same-machine session creation avoided a
  remote round-trip, yet returned `confirmed: false`. When a local Role carried an
  unsupported `thought_level`, `validateSessionCreateOptions` treated the local daemon's
  own capability snapshot as unconfirmed and rejected with retryable `SYNC_UNAVAILABLE`
  instead of deterministic `COMMAND_REJECTED`.
- **Borrowed model options in Roles and menus**: custom and registry ACP agents (such as
  Antigravity) are excluded from active multi-model refresh probing
  ([observed model options](../../proposed/architecture/2026-11-11-observed-model-config-options.md)).
  When `session/new` probed a thinking model (`claude-opus-4-6-thinking`), selecting a
  non-thinking model (`gemini-orchestrator`) borrowed `thought_level: 'high'`. Both
  `applyAgentRoleRunConfigDefaults` and `prepareAgentRoleTargetForSave` wrote that
  borrowed default into `role.runConfig.configOptionValues`, and `normalizeReasoningEffortSelectors`
  also kept the snapshot's `thought_level` selector when `modelReasoningEfforts[modelId]`
  was `[]`.
- **Provider-flat effort and speed persistence**: `AgentSessionDefaults`,
  `AcpSessionConfigPreferences`, and `SessionRunConfigDraft` stored `thought_level` and
  `fast-mode` in one flat `configOptionValues` map per agent config, so changing effort
  or Codex speed (`off` / `fast` / `ultrafast`, [per-model capability row](2026-09-29-per-model-acp-capability-row.md))
  on one model leaked onto other models. Pre-`speedTiers` Codex `1.12.0` capability
  caches also retained boolean-only `fastMode` until binary upgrade, and mobile composer
  toggles lacked 3-tier speed cycling.

## Decision

1. **Same-replica Machine Flock authority by writer ownership.**
   - `acpCapability` rows in `mf:<machineId>` are written exclusively by that machine's
     daemon (`MachineDocument`). When `daemonTarget.sameReplica` is true and a local
     snapshot exists, `readAgentAcpCapabilitySnapshot` returns `confirmed: true` with
     zero remote sync; it runs `confirmSameReplicaMachineFlockOnMiss` only when the row
     is absent.
   - `agentConfig` and `localProject` rows can be mutated by desktop or mobile clients
     before the daemon's background subscription catches up. Same-replica reads look up
     the local replica first (`confirmed: true` on hit, 0 ms network wait) and call
     `confirmSameReplicaMachineFlockOnMiss` (`syncFlockDocOrThrow(..., { requireRemoteConfirmation: true })`)
     only on a local miss: sync success yields `confirmed: true` so nonexistent ids fail
     deterministically, while sync failure yields `confirmed: false` with retryable
     `SYNC_UNAVAILABLE`.
2. **Passive per-model observation and Role reconciliation.**
   - Whenever a live ACP session switches models (`applyAcpModeAndModel`) or emits a
     `config_option_update` notification (`message-handler.ts`), `WorkspaceDocument.recordObservedAcpModelConfigOptions`
     records the active model's non-model `configOptions` into `mf:<machineId>` in the
     background (`markMachineFlockDirty`), reusing `writeAcpModelConfigOptionsToFlock`
     shape deduplication without blocking the prompt turn.
   - `normalizeReasoningEffortSelectors` removes `thought_level` select controls when
     `modelReasoningEfforts[selectedModelId]` is explicitly `[]`.
   - `applyAgentRoleRunConfigDefaults` and `prepareAgentRoleTargetForSave` skip unset
     model-dependent selectors (`thought_level`, `fast-mode`, `speed`) when
     `modelConfigOptionsSource === 'borrowed'`.
   - Shared `reconcileAgentRoleRunConfig` strips non-permission options proven
     unsupported by the Role's target model (via `observedModelConfigOptions`,
     `declaredModelControls`, or `modelReasoningEfforts`) both during workspace Role
     maintenance ([reconciliation Spec](../../../../specs/agent-role-schema-reconciliation.md))
     and during `--agent-role` / MCP `agentRoleId` session creation before validation.
3. **Per-model effort and multi-tier speed state.**
   - `AgentSessionDefaults` and `AcpSessionConfigPreferences` add optional
     `modelConfigOptionValues?: Record<string, Record<string, AcpConfigOptionValue>>`,
     and `AcpSessionUserConfigEdits` / `SessionRunConfigDraft` add
     `modelConfigOptions`. Model-dependent options (`thought_level`, `fast-mode`, `speed`)
     are persisted and resolved under their `modelId` (both dedicated `modelId` and
     generic `configOptionValues.model`), migrating legacy flat entries onto the
     outgoing model when switching models while keeping `useAcpSessionConfigSelectionState`
     a pure render derivation.
   - Builtin Codex capability `sourceVersion` appends `speed-tiers:1` so pre-`speedTiers`
     caches refresh automatically; `'normal'` and `'standard'` aliases normalize to
     `'off'` / `false` across UI, CLI, and MCP (`speedTiers` / `speedTier`), and
     `MobileFastModeToggle` cycles `off` -> `fast` -> `ultrafast` -> `off`.

## Alternatives

- **Always run `syncFlockDocOrThrow` on `sameReplica` reads**: restores remote
  confirmation for misses, but puts a cloud round-trip back onto every local sub-session
  creation and breaks offline local execution when the row is already present locally.
- **Actively probe every model on custom and registry ACP agents**: rejected for the
  same reason as [observed model options](../../proposed/architecture/2026-11-11-observed-model-config-options.md)
  — third-party adapters can persist global state on `set_config_option` or expose large
  model catalogs. Passive recording from user-initiated model switches observes real
  sessions without extra processes or synthetic switches.
- **Reconcile per-model selection state with a `useEffect` on model change**: violates
  the composer's pure-derivation invariant (#185) and risks render oscillation when
  selector catalogs depend on candidate model selection.

## Limits

- Before a custom or registry agent's non-default model has been used once on that
  machine, its option list remains `borrowed`: the composer keeps provisional controls
  visible so valid options remain selectable, while Role authoring avoids auto-pinning
  borrowed defaults.

## Verification

- `apps/cli/src/commands/session.test.ts`, `apps/cli/src/mcp/daemon-session-tools.test.ts`,
  and `apps/cli/src/lib/loro/machine-document-capabilities.test.ts`: same-replica
  capability authority, miss-only remote confirmation, Role target-model reconciliation
  on create, passive per-model option recording, and MCP `speedTier` / `speedTiers`.
- `packages/shared/tests/acp-run-config.test.ts` and `packages/shared/tests/agent-role.test.ts`:
  `'normal'` / `'standard'` speed alias normalization and `reconcileAgentRoleRunConfig`.
- `packages/components/tests/acp-selector-options.test.ts`,
  `acp-session-config-selection.test.ts`, `session-config-selection-oscillation.test.tsx`,
  `use-chat-landing-defaults.test.tsx`, `mobile-run-config-sheet.test.tsx`,
  `agent-role-form.test.ts`, and `use-agent-role-schema-reconciliation.test.tsx`.
