# Built-in Workspace MCP connector architecture

The product contract is the draft
[built-in Workspace MCP connector Spec](../../specs/builtin-workspace-mcp-connectors.md). This
page explains how the shared catalog, settings UI, target CLI, encrypted credential store, and
ACP startup fit together. Binding credential rules remain in
[`apps/cli/src/mcp/AGENTS.md`](../../apps/cli/src/mcp/AGENTS.md) and catalog rules remain in
[`packages/shared/AGENTS.md`](../../packages/shared/AGENTS.md).

## Responsibility split

```text
Workspace Flock
  public preset row: id + provider + version + access profile + display metadata
           │
           ├── Settings UI: add/remove cards and choose a target Machine
           │         │
           │         └── same-Machine RPC: status / authorize / test / disconnect
           │
           └── target CLI
                     ├── OAuth coordinator: discovery, PKCE, callback, refresh
                     ├── encrypted store: user + workspace + entry binding
                     └── session resolver: access token → in-memory MCP config
                                                    │
ACP Agent ──────────────────────────────────────────┘ connects to provider endpoint
```

The public catalog is portable and collaborative. Authorization is private execution state. A
Machine can therefore read the same preset row as every other member without gaining any member's
provider credential.

## Catalog representation

`WorkspaceMcpServerMeta.source.kind = "builtin"` identifies a preset. The row carries a
`providerId`, `presetVersion`, `accessProfile`, and a bounded provider-specific `publicOptions`
record. Its transport is HTTP and its `connection` must be absent. The parser rejects a built-in
row containing a URL, token, or header override, so a malicious or newer peer cannot redirect a
stored credential through Workspace data.

`packages/shared/src/builtin-mcp-providers.ts` owns the reviewed endpoints, documentation links,
OAuth origins, issuer, supported access profiles, and preset version. Settings uses the registry
to create a row; the CLI uses the same registry to derive the actual endpoint. A credential
fingerprint covers every authorization-relevant field, so changing the row or registry requires
authorization again.

## Authorization path

For an OAuth provider, settings first persists the preset row and calls the selected Machine.
The CLI binds an HTTP callback server to `127.0.0.1` on an ephemeral port and delegates MCP OAuth
discovery plus PKCE/DCR mechanics to the pinned MCP SDK. A browser opens the returned authorization
URL. Only a callback with the matching state and live transaction can exchange its code.

Every provider request is bounded, uses manual redirect handling, and is checked against the
registry's HTTPS origin allowlist. Protected-resource metadata must validate before authorization
server discovery continues. Resource and issuer values must match the pinned provider policy.
PostHog additionally rewrites the metadata visible to the SDK for a read-only profile, removing
write scopes while retaining identity and read scopes.

Feishu takes a separate path. Settings opens the official provider page and asks the user to
paste the generated personal URL. Shared RPC validation limits its size; CLI validation requires
HTTPS, no embedded basic-auth credentials, and an allowlisted Feishu/Lark hostname. The URL is
plain only inside the same-Machine RPC boundary, then is encrypted at rest.

## Credential storage

`WorkspaceMcpCredentialStore` keeps a random 256-bit AES key and an AES-GCM envelope in separate
owner-only files under the Lody data directory. The ciphertext file is replaced atomically.
Mutations use the existing file lock so distinct workspace service instances cannot lose each
other's writes.

OAuth bindings include token state, dynamic client/discovery state, callback URI, timestamps,
credential id, and authorization fingerprint. Feishu bindings include only the secret URL,
credential id, fingerprint, and connected time. Store keys include user id, Workspace id, and
catalog entry id. Anyone already executing as the daemon's OS user can read the key and
ciphertext and is outside this storage threat model.

## Session startup and refresh

The session MCP loader keeps the established two-phase startup order: catalog I/O completes
before ACP initialization, while capability selection happens after initialization. For each
selected built-in row, it asks the workspace-owned authorization service for a connection. A
valid unexpired binding becomes an ordinary in-memory HTTP connection; an expiring binding uses
one coalesced refresh per entry. The Agent receives an Authorization bearer access token, never a
refresh token or discovery/client state.

Missing or fingerprint-mismatched credentials leave the preset intact and produce
`auth_required`. Empty MCP selection returns immediately; orphan cleanup starts only as
best-effort background work when local bindings exist.

## Concurrent lifecycle operations

One authorization service is owned per CLI workspace. Per-entry operation tails serialize
authorization starts, secret updates, and disconnects. Generations invalidate stale callback and
refresh completions; credential ids allow compare-and-delete without deleting a newer login.
Refreshes are coalesced and connection tests have per-entry abort controllers.

Disconnect and orphan cleanup close OAuth callbacks, abort and drain connection tests, wait for
captured refreshes, and delete credentials. Orphan ids remain tombstoned in the service so a late
resolver cannot recreate a binding after catalog deletion. Service disposal marks itself inactive
before draining operations, which prevents new callbacks, tests, refreshes, or writes from
surviving workspace shutdown.

## Current verification boundary

Unit tests cover schema rejection, provider scope, encrypted-at-rest storage, cross-instance
mutation serialization, OAuth callback and refresh behavior, origin/resource/issuer policy,
PostHog's query-free OAuth resource and read-only scopes, timeouts, disposal, disconnect and
orphan races, session resolution, and UI catalog helpers. They use deterministic provider
fixtures. Real-account provider authorization and the final browser UX are not proven by those
fixtures and must be validated separately before treating every connector as generally available.
