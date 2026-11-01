# Shared contracts

`CLAUDE.md` symlinks here. Edit `AGENTS.md` only.

Discover archive/restore/delete from one ready Repo snapshot, never UI caches.
Archive uses `collectSessionArchiveTargets`; restore/delete keep direct containment.
Exact deletion bypasses discovery: [relations](../../specs/session-relations.md).

## Session history

- History tolerates unknown string item types without rewriting or blocking unrelated writes.
  Keep known-type guards and input parsing; test: `tests/session-doc-forward-compat.test.ts`.
- `createSessionMirror` owns renderer/CLI history through one `HistoryWriter`, including
  legacy callbacks. No raw history writes or second writer; read flags never change ownership.
- Validate new turns and changed known fields/items before applying a command, never
  unchanged history. Invalid commands preserve the old values and throw content-free
  diagnostics; they must not leave partial history writes. Keep stored unknown fields
  and unchanged opaque items; do not sanitize/rewrite a whole stored document.
- New inputs use the shared message parsers. Known protocol extension dictionaries
  retain JSON data, not arbitrary JS objects. Storage layout is an insertion policy in
  `schema.ts`: new metadata strings stay primitive and `LoroText` is declared only for
  streaming fields, at every nesting level. Stored values keep their representation and
  opening never rewrites them.

- Parser coverage must include nested discriminators (`system_notice.name`) and
  correlated metadata, not just item `type`. Fork regression tests must cross the
  actual SessionDocument/HistoryWriter boundary; a mock updateHistory cannot prove it.
- Copying stored history uses a writer-captured snapshot, never a caller-supplied "trusted"
  array. Preserve unchanged opaque content; parse authored changes and new notices. Prepend
  copies without replacing target initialization containers; reject colliding ids. Rollback
  captures only the changed range, retains untouched/later rows, and rejects row identity/order
  edits in that range, except pending-to-seen on newly inserted user rows.
  External ACP imports remain new input.
- Session data ports (`src/session-data`): UI/CLI business depends on `SessionData`
  (set/clear and shared validation), never a second writer. Invariants: [session-data scope](src/session-data/AGENTS.md).
- Tool fields other than type/toolCallId are independent
  edits: derive their parsers from the tool message schema and validate changed fields,
  not untouched stored payloads. Content-list edits retain unchanged blocks and parse
  authored blocks; tool identity changes still use the complete item parser.
- Normalize legacy built-in CLI selectors on new history input only. Independent stored
  input-config metadata edits validate changed fields, not untouched historical values.
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
- Streaming/mixed writes use indexed `updateTail`/`updateEntry`, with child output windows;
  snapshot/progress never reads transcripts. Preserve ownership/ids, preflight all writes,
  invalidate stale indexes. Full-history updates: structural commands or unwindowable storage.
- Permission responses inspect request metadata and materialize only the matching turn;
  a supplied turn id restricts lookup to that turn. Preserve legacy JSON metadata on lookup.
- Mirror's text-event optimization ships upstream in pinned `loro-mirror`; no local patch
  exists and no storage schema or write validation depends on it.
- Subagent events must preserve run identity and root ownership.

## Machine protocol negotiation

- Ask Question consumers must preserve Core note/replacement semantics and validate
  associations per the [notes contract](../../specs/ask-question-answer-notes.md).

- Independent Plan configuration uses Core's boolean `plan_mode`, including static
  capabilities, semantic dispatch, and UI toggles. Preserve `collaboration_mode`
  default/plan only for agents that advertise the legacy option; planning must not
  change permission policy.

- Session automation readers require `sessionAutomations` locally or `remoteAutomationControl` remotely; unsupported machines expose no controls, polling or connection warning.
- Daemon workflows gate on `MachineMeta.protocolCapabilities`, never CLI version.
  Missing means unsupported. Full-message schedules require v3 and `messageVersion: 1`.
- An ACP capability entry may carry the agent's advertised `authMethods`; absence means no probe
  has asked, and an empty list records that the agent advertises none. The same list is returned
  by a capability refresh. `methodId` on an authenticate `start` request is negotiated by
  `acpAuthenticationMethodSelection`, because the strict request schema rejects an unknown field
  on older daemons.
- ACP `cacheVersion` gates freshness, not readability. Preserve understood fields across
  versions and runtime-override matching; omit known-incompatible fields. Pre-v11 commands
  can contain project data: Machine Flock owns probe previews, Sessions own actual lists.
- Quota: share `src/subscription-quota.ts`; key `agentConfigId + limitId`.
  Bound Providers ignore legacy; delete scoped rows.

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

## Workspace MCP / Roles

- MCP/UI: read [auth contracts](src/AGENTS.md).
  Catalog/defaults: workspace Flock; selections: turns. Missing project rows inherit
  workspace defaults; `[]` disables all. Resolve defaults only at authoring; no machine
  bindings. Preserve `mcpServerIds: []`; send the driving turn's selection to ACP,
  never reread history.
- MCP/Role catalog writes resolve on local Flock durability, followed by explicit
  upload. Settings neither await nor report upload; its failure never fails or rolls
  back a durable write. CLI reports its sync result. See
  [catalog explanation](../../.agents/docs/workspace-catalog-durability.md).
- Roles use one workspace Flock `agentRole` family; sharing changes `visibility`.
  No secrets, API keys, MCP selections or memory contents. Apply
  `isSensitiveAgentRoleConfigOptionKey` on read/write. Permission pins use
  `runConfig.modeId` or `_permission`: hide the composer permission button,
  keep warning-tone markings. No Role-level auto-approval policy.
  Settings/mentions use `canReadAgentRole`/`canManageAgentRole`; explicit MCP
  lookup needs no mention grant.
- Each Role target binds `machineId + agentConfigId`; never guess or fall back. One
  target is a v1 row, more are v2 ([Spec](../../specs/agent-role-machine-targets.md)).
  Unavailable targets stay listed, unmentionable. Freeze prompt/target/revision/config
  at acceptance; retries ignore edits. Session Role metadata: provenance only.
  `resolveSessionExecutionInputBlocks` owns text; raw blocks supply attachments.
- Memory stores provider/id references, frozen per turn; daemon/env rules:
  [memory contract](../../specs/agent-role-memory.md).
- Keep `author`, human `userId`, and recipient execution config separate.
  [Contract](../../specs/message-author-identity.md).

Presence: E2EE requires UUID session IDs and bounded plaintext allowlists on publish/receive;
ordinary behavior stays unchanged. [Contract](../../.agents/docs/cli-lib-loro-presence.md).

Encrypted attachment manifests contain secret per-file keys and belong only in protected conversation content or local recovery receipts. Relay requests use opaque metadata and attachment-only grants; never publish a manifest or key in a URL. Format and recovery rationale: [attachment decision](../../.agents/notes/implemented/architecture/2026-10-28-encrypted-attachments.md).
