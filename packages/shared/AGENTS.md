# Shared contracts

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Archive uses `collectSessionArchiveTargets` for contained/opened descendants;
restore/delete retain containment-only targets. See [relations](../../specs/session-relations.md).

## Session history

- Session history storage tolerates unknown string item types from newer peers without
  rewriting them or blocking unrelated writes. Keep known-type guards and external-input
  parsing; `tests/session-doc-forward-compat.test.ts` covers this separately from unknown root keys.
- `createSessionMirror` is the renderer/CLI session entrypoint. Its `HistoryWriter`
  owns local history writes, including legacy callback updates; no raw history writes
  or second Mirror writer. Read-path feature flags must never change this owner.
- Validate new turns and changed known fields/items before applying a command, never
  unchanged history. Invalid commands preserve the old values and throw content-free
  diagnostics; they must not leave partial history writes. Keep stored unknown fields
  and unchanged opaque items; do not sanitize/rewrite a whole stored document.
- New inputs use the shared message parsers. Known protocol extension dictionaries
  retain JSON data, not arbitrary JS objects. Storage layout stays separate: coordinate
  any `Any.storageSchema` adoption with its Mirror patch, including rollback.
  Rationale: [single writer](../../.agents/notes/implemented/architecture/2026-09-07-single-history-writer.md).
- Parser coverage must include nested discriminators (`system_notice.name`) and
  correlated metadata, not just item `type`. Fork regression tests must cross the
  actual SessionDocument/HistoryWriter boundary; a mock updateHistory cannot prove it.
- Copying stored history uses a writer-captured snapshot, never a caller-supplied
  "trusted" array. Preserve unchanged opaque content; parse authored changes and new
  notices. Prepend copies to target initialization rows without replacing their containers;
  reject colliding ids. Rollback captures only the changed range and retains current content
  of untouched rows and later appended rows. Reject changes to existing row identity/order and edits inside that range,
  except pending-to-seen read acknowledgement on newly inserted user rows.
  External ACP imports remain new input.
- Tool fields other than type/toolCallId are independent
  edits: derive their parsers from the tool message schema and validate changed fields,
  not untouched stored payloads. Content-list edits retain unchanged blocks and parse
  authored blocks; tool identity changes still use the complete item parser.
- Normalize legacy built-in CLI selectors on new history input only. Independent stored
  input-config and task-proposal metadata edits validate changed fields, not untouched
  historical values; proposal identity changes still require complete parsing.
- ACP tool blocks and locations are explicit JSON extension boundaries. Unknown block
  types must not bypass validation of malformed known variants. Preserve declared `_meta`
  and extension keys; closed execution configuration still selects declared fields.
- Steer provenance is a declared history input-config field, not an unknown extension.
  Both new writes and read normalization must retain it for edit-and-resend checks.
- Scalar/fileDiff writes read and diff only the requested field, never the turn's items.
  Writer input parsers derive from schema definitions with all refinements retained;
  never mutate the original RPC schemas. Parsing filters and validates in one pass.
  `readStored` returns detached JSON for hashing, not stored-copy provenance. Keep `capture`
  protection for callers that can author copies from an old snapshot.
- Target-local streaming uses `updateEntry`; it must not produce/plan the entire history.
  Resolve the live turn on each call, preserve immutable ids, and preflight before writing.
  Generic history updates remain for operations with cross-turn ownership or structural edits.
- The pinned Mirror text-event patch copies only an existing single text leaf's path.
  Preserve descriptors, old snapshots and subscriber delivery; structural/multi-event/tree
  paths retain the general reader. Future Mirror patches must compose with this patch,
  never silently replace it. No storage schema or write validation depends on this optimization.

These contracts bind producers and consumers, including UI and CLI callers outside
this package. Read them when changing daemon protocol negotiation, MCP/Role catalogs,
per-turn MCP selection, or Role-based session creation and dispatch.

## Machine protocol negotiation

- Independent Plan configuration uses Core's boolean `plan_mode`, including static
  capabilities, semantic dispatch, and UI toggles. Preserve `collaboration_mode`
  default/plan only for agents that advertise the legacy option; planning must not
  change permission policy.

- Daemon-backed workflows negotiate versions through
  `MachineMeta.protocolCapabilities`; never infer from the CLI release. Missing
  capabilities mean unsupported. Set and version checks share one binding in
  `packages/shared/src/machine-protocol-capabilities.ts` so a key never travels
  without its version.
- ACP capability `cacheVersion` controls refresh freshness, never readability. Consumers
  preserve understood fields from parsed older or newer entries during mixed-version
  operation, adapting only fields with known incompatible semantics; runtime-override source
  matching remains a separate applicability gate.

## Session goal control

- A goal action's transport follows what it does, not what the agent is. Status-only
  actions (`pause`, `clear`) use the `_lody/session/goal` request and must reach a
  goal whose prompt is still open; actions that start work (`set`, `resume`) run
  inside a Lody-owned prompt carrying `_meta.lody.goalControl`, because every unit of
  agent work needs a conversation entry to be attributed to. Never start goal work
  from the request path.
- Offer only the actions the runtime advertised in its ACP capability, never a
  provider name check. A goal turn carries no run configuration, so resuming cannot
  change model or mode. Behavior: [goal control Spec](../../specs/session-goal-control.md).

## Workspace MCP and Agent Roles

- Workspace MCP has exactly two durable layers: catalog entries in the workspace Flock
  document and selected ids in each user turn input config. Do not add machine bindings.
  Preserve `mcpServerIds: []` as an explicit empty selection; dispatch must carry the
  driving turn's selection into ACP startup rather than rereading session history.
- MCP/Role catalog writes resolve on local Flock durability, followed by explicit
  upload. Settings neither await nor report upload; upload failure must not fail or
  roll back a durable write. CLI reports its sync result. See
  [catalog explanation](../../.agents/docs/workspace-catalog-durability.md).
- Roles use one workspace Flock `agentRole` family; sharing updates `visibility`.
  Store no secrets, API keys, MCP selections, or memory; apply
  `isSensitiveAgentRoleConfigOptionKey` on read and write. Roles pin permission via
  `runConfig.modeId` or `_permission`; hide the separate composer permission button
  when pinned, but keep warning-tone modes visibly marked on every such surface.
  Role-level auto-approval policy is out of scope. Settings/mentions use
  `canReadAgentRole`/`canManageAgentRole`; MCP resolves explicit Role ids from the
  catalog without requiring mention-scoped authorization.
- Roles bind exact `machineId + agentConfigId`, never fall back, and remain listed
  with precise reasons but unmentionable when machine/config/model/mode is unavailable.
  Before Operation acceptance, MCP resolves the current `agentRoleId` row and freezes
  canonical Prompt, target, Role revision, and dispatch config into the Operation;
  edits/deletion cannot change recovery or retry. `SessionMeta.agentRoleId` and
  `agentRoleRevision` are display-only creation provenance.
