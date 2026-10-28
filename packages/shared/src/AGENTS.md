# Shared source contracts

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
