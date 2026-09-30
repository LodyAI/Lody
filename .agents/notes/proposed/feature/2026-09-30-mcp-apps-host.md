# Hosting MCP Apps in Lody sessions

Status: proposed
Translation: current

[中文](2026-09-30-mcp-apps-host.zh.md)

## Abstract

Codex renders a tool whose MCP server declares an MCP Apps UI (SEP-1865) as an
interactive embedded view, while Lody showed only "Ran mcp.…". The proposal keeps the
MCP connection in the agent: history stores a small descriptor, and the desktop fetches
the app's HTML, tool input and tool result on demand from the live agent through a
Machine RPC, sandboxing the view in an iframe. The app may read resources and call
tools only on its originating server, and only tools visible to apps. The main
trade-off is that a view needs a running agent: history viewed later without one shows
the app as unavailable.

## Decision

- **Negotiation.** The Lody client advertises `clientCapabilities._meta.lody.mcpApps`
  only from the real session client; capability probes and history-catalog clients
  never render tool calls. An adapter emits `tool_call._meta.lody.mcpApp` only after
  that negotiation, and Lody uses the `_lody/mcp_apps/*` methods only when the agent
  advertised `agentCapabilities._meta.lody.mcpApps`.
- **Lazy storage.** `history-apply` stores `toolCall.mcpApp = {server, tool,
  resourceUri, appName?, preferredDisplayMode?}` (strings at most 2048 characters,
  `resourceUri` must be `ui://`). Invalid descriptors are ignored, an unknown display
  mode or oversized app name drops only that field, and an update without the meta
  keeps the stored descriptor. The field is optional, so older documents stay valid
  and older readers ignore it; HTML, input and result never enter the CRDT.
- **Transport.** One Machine RPC, `session/mcp-app`, carries a discriminated request
  (`load`, `resource_read`, `tool_call`) with the viewer's `userId`. The daemon checks
  machine access, then forwards with the agent's own session id. Failures are typed:
  `MCP_APP_UNAVAILABLE`, `MCP_APP_ACCESS_DENIED`, `MCP_APP_AGENT_ERROR`,
  `MCP_APP_RESPONSE_TOO_LARGE` (8 MiB). It uses the shared lane, not the control lane,
  because app tool calls have unbounded latency.
- **No agent boot.** Goal control starts a Lody-owned turn when no agent runs. MCP
  Apps must not: opening history would spawn agent processes. Without a live agent the
  request reports `MCP_APP_UNAVAILABLE`.
- **Scoping.** Every request names the originating `toolCallId`. The adapter pins
  resource reads and tool calls to that call's server and rejects tools whose
  `_meta.ui.visibility` excludes `"app"`.
- **Sandbox.** The renderer hosts the view in a frame without `allow-same-origin`,
  preload or credentials, with a CSP derived from the resource's `_meta.ui.csp` and
  a deny-by-default fallback. The OSS desktop makes no product-cloud requests.

## Alternatives considered

- Storing the HTML and tool result in history makes views work offline but puts large,
  possibly sensitive payloads into the synced CRDT.
- Encrypting results with the owner-session content envelope, as `file/preview` does,
  was deferred: steer and goal payloads already travel as plaintext on this transport.

## Limits

Not yet verified end to end. Views need the agent that ran the tool to still hold it
(the Codex adapter falls back to `thread/read` after a restart). Remote-machine traffic
goes through Loro Streams unencrypted; revisit if app results become sensitive.
