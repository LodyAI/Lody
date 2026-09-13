# Keep built-in MCP credentials on the execution Machine

Status: implemented
Translation: current

[中文](2026-09-09-builtin-workspace-mcp-connectors.zh.md)

## Abstract

Workspace MCP previously required users to enter provider transport and credential details by
hand, while its shared catalog was unsafe for personal OAuth tokens or secret-bearing URLs. Lody
now provides reviewed presets for Linear, Notion, Cloudflare, PostHog, and Feishu, but keeps each
authorization encrypted on the Machine that runs the Agent. This avoids a backend credential
service and preserves the collaborative catalog; the trade-off is that users authorize each
Machine separately and remote browser callback relay remains out of scope.

## Decision

The Workspace shares capability identity, not provider identity. A built-in catalog entry stores
only provider, preset version, access profile, bounded public options, and display metadata. Each
user/Machine pair owns a separate credential binding for that entry.

The target CLI owns OAuth discovery, browser callback, token refresh, connection tests, and
encrypted storage. Settings reaches those operations only through same-Machine RPC. Session
startup converts a valid binding into a temporary HTTP MCP configuration and exposes only an
access token to the Agent process.

The provider set is deliberately fixed to Linear, Notion, Cloudflare, PostHog, and Feishu. Canva
and Slack were removed from the requested first version. Linear and PostHog default to read-only;
Notion and Cloudflare let their authorization pages choose permissions; Feishu uses its official
personal-URL setup until it offers an equivalent standard OAuth client flow.

## Security and lifecycle boundary

No provider credential enters Workspace Flock, optional cloud storage, analytics, chat, or
ordinary logs. Convex is not required. OAuth destinations, issuer, and resource are pinned by the
built-in registry, and PostHog read-only authorization filters metadata write scopes rather than
relying only on a transport query.

Authorization fingerprints prevent a credential from following a catalog entry whose provider
or policy changed. File locks, per-entry operation serialization, generations, credential-id
compare-and-delete, coalesced refresh, and abortable tests make disconnect, removal, callback,
refresh, and shutdown deletion-winning operations.

## Alternatives

Storing tokens in the Workspace catalog was rejected because every member who can read that
document could obtain a personal provider credential. A backend token service was rejected for
the first version because local execution does not require cross-Machine synchronization and a
service would create a new high-value multi-tenant secret boundary.

Delegating OAuth to each ACP Agent was rejected because Agents expose different login and refresh
behavior and would make connector availability depend on the selected Agent. A remote callback
relay was deferred because it needs a separately reviewed, end-to-end protected handoff; the
same-Machine loopback flow is sufficient for the initial desktop behavior.

## Evidence and verification

Product intent is recorded in the draft
[`specs/builtin-workspace-mcp-connectors.md`](../../../../specs/builtin-workspace-mcp-connectors.md),
and the cross-module flow is explained in
[`builtin-workspace-mcp-connectors.md`](../../../docs/builtin-workspace-mcp-connectors.md).
Implementation and deterministic security/race tests span shared schemas, settings components,
the CLI authorization service, credential store, and session resolver. This repository migration
passes `pnpm format`, `pnpm check`, `pnpm run docs check`, and the focused 38-test connector suite.
The prior implementation also passed adversarial security/correctness review. Live authorization
with real provider accounts remains unverified.
