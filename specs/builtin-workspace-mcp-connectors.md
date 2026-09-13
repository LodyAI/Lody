# Built-in Workspace MCP connectors

Status: draft
Translation: current

[中文](builtin-workspace-mcp-connectors.zh.md)

Lody Workspace settings offer reviewed connector presets for Linear, Notion, Cloudflare,
PostHog, and Feishu. A user can add a preset without knowing its transport URL or headers, then
authorize the provider on the Machine that will run the Agent. Custom Workspace MCP servers
remain available and unchanged.

## Workspace and Machine responsibilities

A built-in connector has two deliberately separate states:

- the Workspace catalog contains a public preset identity, version, access profile, display
  metadata, and no `connection` value;
- each user authorizes that catalog entry independently on each target Machine.

Provider credentials are never Workspace data. OAuth access and refresh tokens, dynamic client
information, discovery state, and Feishu personal MCP URLs stay in encrypted Machine-local
storage keyed by user, Workspace, and catalog entry. Authorization codes and PKCE verifiers are
process-local. Neither the catalog nor an optional cloud service, including Convex, stores or
relays these values.

The settings UI manages credentials only through same-Machine RPC. If the selected Machine is
remote, offline, or lacks the capability, Lody keeps the public catalog entry and asks the user
to open settings on that Machine. It does not fall back to a cloud credential path.

## Provider behavior

Linear, Notion, Cloudflare, and PostHog use browser-based MCP OAuth. Lody performs protected
resource and authorization-server discovery, Authorization Code with PKCE S256, and dynamic
client registration when required. OAuth destinations and metadata are constrained by the
built-in provider registry; redirect responses and mismatched resource or issuer metadata fail
closed.

Linear uses its read-only MCP endpoint by default. Notion and Cloudflare leave permissions to
their provider authorization pages. Cloudflare keeps its default Code Mode endpoint. PostHog
uses `mode=cli&readonly=true` by default; its OAuth resource omits transport query parameters,
and the read-only flow requests identity and `*:read` scopes only.

Feishu uses guided setup because its end-user integration returns a personal MCP URL rather
than a standard client OAuth flow. Lody opens the official setup page, accepts only an HTTPS URL
on an allowlisted Feishu/Lark domain, stores the complete URL as a Machine-local secret, and
never writes it to the catalog.

## Session behavior

Adding a connector does not enable it for every turn. Selection continues to use the existing
`mcpServerIds` turn configuration, including an explicit empty list. Before ACP session startup,
the target CLI resolves selected built-in entries from its local credential store and refreshes
an expiring OAuth token when possible. Only the access token enters the in-memory HTTP MCP
configuration supplied to the Agent; refresh tokens never do.

An entry with no matching local credential resolves as `auth_required` and is omitted from the
Agent's MCP server list. A changed provider, preset version, access profile, endpoint, OAuth
resource, public option, or issuer invalidates the existing authorization and requires a new
one. Authorization affects later session starts; a running Agent does not hot-load a connector.

## Lifecycle and recovery

Users can inspect status, retry authorization, test a connection, or disconnect it on the
selected Machine. Disconnect, authorization callback, refresh, connection test, service
shutdown, and catalog-orphan cleanup are serialized or generation-checked so a late operation
cannot restore a deleted credential. Removing a built-in catalog entry attempts to disconnect
the selected Machine and lets every Machine delete its own orphaned binding when it next reads
the catalog.

Provider or network failure does not remove the public catalog entry. A user can retry from the
same card. Manual custom MCP configuration remains the advanced path for other providers,
stdio, shared API keys, and explicitly managed HTTP headers.

## Initial limits

The first version does not sync credentials between Machines, proxy provider traffic through
Lody, provide service-account authorization, or add Canva and Slack presets. It does not expose
the latent Linear/PostHog read-write profile in settings. Real-account browser authorization
against every provider remains a release-validation task; deterministic fixtures cover the
protocol and security boundaries in this repository.

## Evidence

Provider definitions and public preset validation are in
`packages/shared/src/builtin-mcp-providers.ts` and `packages/shared/src/workspace-mcp.ts`.
Machine-local authorization is implemented by `apps/cli/src/mcp/workspace-mcp-auth-service.ts`
and `apps/cli/src/mcp/workspace-mcp-credential-store.ts`. Settings UI lives in
`packages/components/src/components/settings/builtin-mcp-connector-grid.tsx` and
`packages/components/src/components/settings/mcp-setting.tsx`; session resolution lives in
`apps/cli/src/agent/session-mcp-resolver.ts`.
