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
  `MCP_APP_RESPONSE_TOO_LARGE` (16 MiB less 64 KiB of serialized JSON: a real app's
  HTML was 7,091,831 bytes before escaping, and the daemon's 16 MiB local IPC response
  cap bounds it). It uses the shared lane, not the control lane, because app tool calls
  have unbounded latency.
- **No agent boot.** Goal control starts a Lody-owned turn when no agent runs. MCP
  Apps must not: opening history would spawn agent processes. Without a live agent the
  request reports `MCP_APP_UNAVAILABLE`.
- **Scoping.** Every request names the originating `toolCallId`. The adapter pins
  resource reads and tool calls to that call's server and rejects tools whose
  `_meta.ui.visibility` excludes `"app"`. Codex lists and calls `codex_apps` tools as
  `<connector>.<tool>` while the app's HTML calls the bare name. `codex_apps` aggregates
  many connectors on one server, so there an app name always resolves inside the
  originating tool's connector prefix and is forwarded namespaced; any other
  connector's tool is rejected, even by its exact name.
- **Sandbox.** The renderer hosts the view in a `credentialless` frame with
  `sandbox="allow-scripts"` (an opaque origin) and no preload, with a CSP derived from
  the resource's `_meta.ui.csp` and a deny-by-default fallback. `connectDomains` accepts `https://` and `wss://` origins,
  every other directive only `https://`; plaintext `http://` and `ws://` are always
  dropped. The OSS desktop makes no product-cloud requests.
- **View sandbox.** Before writing the app document, the proxy installs in-memory
  `localStorage`, `sessionStorage` and `document.cookie`, so views that use them run
  without `SecurityError` and nothing reaches disk. `_meta.ui.domain` is not honored:
  Lody has no public sandbox domain.
- **Sandbox proxy scheme.** `srcdoc`, `blob:` and `data:` frames inherit the renderer's
  meta CSP, which has no `'unsafe-inline'`; checked in Electron 39.5.1 and Chromium 153,
  app inline scripts never run there. The frame therefore loads the fixed proxy page
  `lody-mcp-app://sandbox/`, whose response CSP is an upper bound (`https:`, plus
  `wss:` in `connect-src`). The
  renderer posts the app HTML after `sandbox-proxy-ready` (the SEP-1865 proxy
  handshake) and the proxy replaces its document; the per-app policy is prepended as
  the first `<head>` node. The renderer `frame-src` admits only this scheme besides
  its existing sources, so the frame cannot navigate to an arbitrary https page.
- **Display.** A completed call renders "Opened {app}" with the frame inline; fullscreen
  moves the same frame into a dialog (`moveBefore`, else reload and re-handshake). A
  failed call keeps the ordinary tool row; a missing host, read-only viewer or load
  error shows the app as unavailable.
- **Host context.** The official SDK validates `ui/initialize` and every
  `host-context-changed` with its schemas and disconnects on a mismatch. Dimensions
  always carry a width and a height constraint: inline sends the measured slot `width`
  and `maxHeight`, full screen the dialog's `width` and `height`, re-sent on resize and
  mode change. `toolInfo` is omitted because the SDK requires the full tool definition,
  which the host does not receive. A component test validates both messages with the
  SDK's own schemas.

## Alternatives considered

- Storing the HTML and tool result in history makes views work offline but puts large,
  possibly sensitive payloads into the synced CRDT.
- Encrypting results with the owner-session content envelope, as `file/preview` does,
  was deferred: steer and goal payloads already travel as plaintext on this transport.
- A per-app origin with `allow-same-origin` was rejected. Under `credentialless`,
  Chromium (Electron 43.7.6) keeps each load's nonce-partitioned storage in the default
  session's LevelDB permanently, and neither `clearData` nor `clearStorageData` removes
  it; without `credentialless`, views would see the default session's cookies.
  Persistent per-app storage needs a dedicated in-memory session (a `<webview>`
  partition), left for a follow-up.

## Limits

Views inside native subagent child sessions report unavailable. Views need the agent that ran the tool to still hold it
(the Codex adapter falls back to `thread/read` after a restart). Remote-machine traffic
goes through Loro Streams unencrypted; revisit if app results become sensitive.
Views run in an opaque origin: fetches carry `Origin: null` and IndexedDB and Cache
Storage are unavailable. Web Storage and cookies last one view load, and the in-memory
stores are not `instanceof Storage`.
