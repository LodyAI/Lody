# CLI source contracts

Parent `AGENTS.md` files apply. `CLAUDE.md` is a symlink; edit `AGENTS.md` only.
These contracts cross agent startup, capability storage, and CLI/MCP dispatch.

## Per-model run config

- INVARIANT: reasoning effort and fast mode are per MODEL, because an ACP probe's `configOptions`
  describe only the model current at probe time. Validate effort against the TARGET model using
  `AcpCapabilityCacheEntry.modelReasoningEfforts` and skip the resulting `validatedConfigIds` in
  `validateTurnConfigOptionValues`. When the cache carries `configOptionsByModel` (registry
  Cursor), mapping, turn validation, and inherited-default filtering read the TARGET model's
  composed options through `resolveAcpConfigOptionsForModel`; inherited defaults are filtered
  against the MERGED target model, and an explicit create `modelId` drops a parent's superseded
  `model` option so the frozen Turn names one model. Dispatch what cannot be checked offline
  as requested. Keep
  runtime rejections in debug diagnostics: Codex/Claude mismatches for model, effort, Fast, or Plan
  never become visible `agent_warning` notices, while other rejections still do. Claude Fable
  models omit Fast, so `fast=false` is skipped as a no-op while `fast=true` is dispatched.

## Registry Cursor capability discovery

- Registry Cursor identity (`cliType: 'registry'` and `agentType: 'cursor'`, never a same-named
  custom or builtin config) gates the `parameterizedModelPicker` opt-in, the
  `CURSOR_PARAMETERIZED_MODEL_PICKER_SOURCE_VERSION_SUFFIX` marker, and the
  `cursorParameterizedModelPicker` protocol capability. `isAcpCapabilityCacheEntryCurrent`
  rejects an unmarked registry Cursor row only on a machine that advertises that capability; a
  legacy daemon's unmarked rows stay current. Predicate, suffix, and capability are one binding
  in `@lody/shared`; never re-derive them in the CLI.
- Registry Cursor's per-model catalog (`configOptionsByModel`, background in
  [agent/README.md](agent/README.md)) is the latest successful `cursor/list_available_models` observation
  from the explicit probe or a created session, never enumerated through
  `session/set_config_option` (it rewrites the user's global Cursor config). A confirmed
  `-32601` clears it and any other failure keeps the stored catalog; the write contract is below. `machine/acp-capabilities-refresh_response.capability` omits the
  catalog: clients parse it through a strict schema, and the Flock row reader tolerates unknown
  fields. `resolveAcpConfigOptionsForModel` in `@lody/shared` is the one composition rule.

## ACP capability rows carry the per-model catalog forward

`MachineDocument.updateAcpCapabilities` takes the catalog as a write command
(`AcpCapabilityCatalogWrite`), not as a plain field: an omitted
`configOptionsByModel` inherits the stored catalog for the same config and the
same `cliType`/`agentType` across `sourceVersion` changes, `null` clears it
because the agent confirmed it publishes none, and a map (including `{}`)
replaces it. `null` is consumed before the entry is built and never reaches the
Flock row or the wire schema. A session snapshot must not drop a catalog it did
not observe, and a probe that observed "none" must not leave a stale one behind.

## Expected ACP sources

`lib/acp-capability-source-publisher.ts` publishes the daemon's expected source versions in
Machine Flock independently of probe results. Registration advertises the same lifetime
epoch; config changes, authoritative room rejoin, and committed runtime installations
invalidate and rescan. Resolve installed current/fallback versions without downloading or
launching agents. Generation and shutdown fences prevent late scans from restoring obsolete
expectations; observed capability writes must never update the expectation snapshot.
