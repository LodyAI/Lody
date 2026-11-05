# Shared source contracts

- New quote spans require `messageQuotes` v1 on the target machine. Execution
  includes the full snapshot as ordinary ACP text, independently of Agent identity.

Parent contracts apply. Before changing MCP catalog serialization, also read
[the authorization decision](../../../.agents/notes/implemented/architecture/2026-10-26-mcp-oauth-local-credentials.md).

- MCP definitions retain workspace synchronization; authentication values never enter
  shared rows. All writers call `assertPublicMcpServer`; literal token/header/env values
  go through local authentication RPC. Exact `${VAR}` references may remain shared.
- `authentication: 'local'` describes a service requirement, never a shared login state
  or machine binding. Read normalization strips legacy secrets without importing them
  into another user's vault or claiming to erase CRDT history.
- Keep local authentication DTOs separate from workspace catalog DTOs. Never add a
  workspace/remote RPC fallback for authentication configuration or tokens.

- MCP settings consumers save definitions before authorization and use only supported
  local-daemon authentication RPC. Private values never enter catalog writes; only an
  explicit authorization action opens the browser. Cancel owned attempts on editor
  disposal, fence late replies, and omit the scope helper line.

## Code Collab

- `codeCollabDiffBlobs` v1 gates the additive manifest/blob methods and opaque
  `[path, 'v']` generation siblings. Legacy file rows stay strict and unchanged;
  content hashes travel only through owner-scoped RPC, never the shared index.
- Encrypted manifest/blob calls retain writer authority and execution claims; Guest
  access is outside this capability. Operational manifest failures are per-file;
  request/path authorization failures still reject the request.
- File-index generation siblings count toward whole-state row/byte limits and
  every publication batch budget. Reserve their space before selecting file paths.
  [Rationale](../../../.agents/notes/implemented/architecture/2026-10-31-remote-diff-transport.md).

## Workspace MCP / Roles

- Catalog/defaults: workspace Flock; selections: turns. Missing project rows inherit
  workspace defaults; `[]` disables all. Resolve defaults only at authoring; no machine
  bindings. Preserve `mcpServerIds: []`; send the driving turn's selection to ACP,
  never reread history.
- MCP/Role catalog writes resolve on local Flock durability, followed by explicit
  upload. Settings neither await nor report upload; its failure never fails or rolls
  back a durable write. CLI reports its sync result. See
  [catalog explanation](../../../.agents/docs/workspace-catalog-durability.md).
- Roles use one workspace Flock `agentRole` family; sharing changes `visibility`.
  No secrets, API keys, MCP selections or memory contents. Apply
  `isSensitiveAgentRoleConfigOptionKey` on read/write. Permission pins use
  `runConfig.modeId` or `_permission`: hide the composer permission button,
  keep warning-tone markings. No Role-level auto-approval policy.
  Settings/mentions use `canReadAgentRole`/`canManageAgentRole`; explicit MCP
  lookup needs no mention grant.
- Each Role target binds `machineId + agentConfigId`; never guess or fall back. One
  target is a v1 row, more are v2 ([Spec](../../../specs/agent-role-machine-targets.md)).
  Unavailable targets stay listed, unmentionable. Freeze prompt/target/revision/config
  at acceptance; retries ignore edits. Session Role metadata: provenance only.
  `resolveSessionExecutionInputBlocks` owns text; raw blocks supply attachments.
- Memory stores provider/id references, frozen per turn; daemon/env rules:
  [memory contract](../../../specs/agent-role-memory.md).
- Keep `author`, human `userId`, and recipient execution config separate.
  [Contract](../../../specs/message-author-identity.md).
