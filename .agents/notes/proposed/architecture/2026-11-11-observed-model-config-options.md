# Read every model's config options during a requested refresh

Status: proposed
Translation: current
Language: [中文](2026-11-11-observed-model-config-options.zh.md)

## Abstract

An agent config keeps one capability snapshot whose `configOptions` describe the
model that was current when it was taken, so every model the adapter does not
declare shows that model's effort ladder and toggles: Dimcode reuses one ladder for
all models (#2568), and Devin's composer lacks levels the selected model accepts.
A refresh a person asks for now switches the probe session to every advertised
model with `session/set_config_option`, stores each model's own answer in a machine
Flock row, and names each model in the refresh progress. The composer, Role editor
and CLI/MCP validation compose the selected model's options from those rows. Live
sessions do no extra probing. Verified with unit and component tests only; no real
adapter has been run end to end, and encrypted remote machines still refresh as
before.

## Problem

- `['acpCapability', configId]` stores one `session/new` snapshot. The probe and
  every created session overwrite it, so which model it describes depends on the
  last session.
- Per-model data exists only where an adapter declares it
  (`_meta.lody.modelCapabilities` for Claude and Codex, Grok's
  `modelReasoningEfforts`) and covers effort and Fast only. See the
  [per-model capability row](../../implemented/architecture/2026-09-29-per-model-acp-capability-row.md).
- ACP returns the new model's full option list from `set_config_option`, so a single
  probe process can answer for every model.

## Decision

1. **Storage.** Most models of one agent share a list, so each distinct list is
   stored once: `['acpModelConfigOptionsShape', configId, shapeId]` holds
   `{ version: 1, configOptions }` (the agent's list without the model selector), and
   `['acpModelConfigOptions', configId, modelId]` holds
   `{ version: 1, sourceVersion, shape }`. `writeAcpModelConfigOptionsToFlock` writes a
   config's answers in one commit, reuses a shape whose content matches (the content
   id is a hash, checked against content), keeps a pointer whose list differs only in
   current values, and removes shapes no model points at.
   `MachineDocument.updateAcpCapabilities` calls it with the snapshot's own model on
   every probe and created session, plus every model a refresh read
   (`AcpCapabilityWriteOptions.modelConfigOptions`). For 112 models with five
   distinct ladders the rows take about 19 KB instead of about 130–150 KB for a copy
   per model.
2. **Reading models.** A refresh request with `readModelOptions: true` (negotiated
   by the `acpModelOptionsRead` v1 machine capability, because older daemons parse
   the request strictly) runs `readEveryModelConfigOptions` after `session/new`.
   It switches to each model in order, keeps an answer only when its model selector
   names that model, skips a model whose switch is rejected, and stops at a switch
   unanswered after `ACP_MODEL_OPTIONS_SWITCH_TIMEOUT_MS` (60 s), keeping what it
   read. There is no overall deadline: a person is watching the progress. The daemon
   reads models only for built-in agents.
3. **Who reads models.** Only `useRefreshMachineAcpCapabilities` sets the flag:
   Settings refresh, the Agent config dialog's probe, Test and Retry, and
   onboarding's dialog. Startup refresh, post-login verification, provider setup
   and the CLI command refresh as before.
4. **Progress.** Each model is reported as a `machine/acp-binary-progress` frame with
   status `reading-model-options` and `configId`, `modelId`, `modelName`,
   `modelIndex`, `modelCount`, so it rides the existing local IPC and Machine RPC
   progress paths. The renderer never stores these frames as runtime install state;
   only the refresh's caller shows them ("Reading options for DeepSeek Flash
   (2/40)").
5. **Composition.** `resolveAcpConfigOptionsForModel` keeps the snapshot for its own
   model or an unrecorded one (`snapshot` / `borrowed`), and otherwise returns the
   snapshot's model selector followed by that model's recorded options
   (`observed`). Declarations still win for effort and Fast. Records from another
   `sourceVersion` are still used until the next answer replaces them. UI
   selectors, the Role editor and CLI/MCP validation (`getAcpModelEffortChoices`,
   `getAcpModelFastSupport`, `withAcpConfigOptionsForModel`) use the composed list;
   without a record behavior is unchanged.

## Alternatives

- **Probe on every model switch in a live session, or keep a query session for the
  composer**: rejected after this design was reviewed; it adds a process lifecycle
  and per-switch requests, while one requested refresh covers every model.
- **Option lists on SessionDoc**: rejected in #343's discussion; draft and landing
  chats have no SessionDoc, and the list is a machine capability.
- **A new progress message type**: every transport (local IPC guards in TS and CJS,
  Machine RPC, the encrypted interaction owner) filters progress by type; a new
  status on the existing frame reuses all of them.
- **A full list per model**: simpler, but it repeats the same permission, Plan and
  Fast options for every model, roughly seven times the bytes for a large catalog.
- **Only each model's differences from the snapshot**: smaller still, but the
  composition rule must then know which options a model removed.

## Limits

- Encrypted remote machines do not read models yet: their interaction session lives
  at most 300 s and an aborted probe writes nothing.
- The renderer and Machine RPC clients keep their existing total refresh backstop
  (`ACP_CAPABILITIES_REFRESH_CLIENT_BACKSTOP_MS`); if it expires, the daemon still
  finishes and writes the rows.
- Only built-in agents read models. Registry and custom agents refresh as before:
  their switches may persist outside the session (registry Cursor rewrites its global
  default model, #343).
- An entitlement change outside Lody is seen only after the next refresh. Rows of
  removed configs or models are not pruned. Older clients ignore the new rows.
- #1215's primary rejection no longer reproduces on `main`; a deterministic
  materialization error still retries until `TARGET_TIMEOUT`.

## Verification

- `packages/shared/tests/acp-run-config.test.ts`: composition, and effort/Fast
  validation against an observed target model.
- `packages/shared/tests/machine-flock.test.ts`: 100 models with three lists store
  three shapes, a current-value change writes nothing, an unused shape is removed,
  and rows attach whatever their source version.
- `packages/shared/tests/machine-protocol-capabilities.test.ts` and
  `local-session-control.test.ts`: the flag is negotiated away for older daemons and
  both local guards accept the request and progress frame.
- `apps/cli/src/agent/acp-capabilities.test.ts`: reads every model, skips a rejected
  switch, stops at an unanswered one, and switches nothing unless asked.
- `apps/cli/src/lib/loro/machine-document-capabilities.test.ts`: per-model writes and
  structure-only change detection.
- `apps/cli/src/commands/session.test.ts`: the #1215 shape validates against the
  observed list.
- `packages/components/tests/acp-selector-options.test.ts` (#2568) and
  `provider-row-reauthentication.test.tsx` (progress text).
- Unverified: real adapters' switch latency and answers, and the desktop UI in a
  running app.
