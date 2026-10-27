# Local ownership of MCP authentication credentials

Status: implemented
Translation: current

[中文](2026-10-26-mcp-oauth-local-credentials.zh.md)

## Abstract

MCP definitions keep workspace ownership and synchronization, while OAuth and manual
credentials stay in the executing account's local system credential store. A native
daemon service connects settings, discovery and selected Agent calls through the MCP
SDK; HTTP Agents receive scoped loopback connections rather than upstream tokens.
Synthetic authorization and cancellation tests pass. Live Slim Tools consent and
secure-store acceptance on every supported OS remain unverified.

## Boundary and compatibility

Catalog names, transports, credential-free endpoints and exact `${VAR}` references
remain shared. `authentication: 'local'` describes a requirement, never a machine binding
or shared login. OAuth tokens, refresh tokens, client registration, client secrets and
literal manual token/header/env values are local. Arbitrary literal env/header values
are conservatively private rather than classified by guessed secret names. Records
bind machine, workspace, local account, entry and expanded connection (including environment-based destinations); SDK issuer/client
stamps preserve authorization-server binding. Destination changes invalidate reuse.
Local RPC checks the UI account against the daemon account; legacy discovery without an account never reads the vault. Other machines authorize independently; foreign requesters receive neither the owner's
vault record nor its daemon environment. E2EE sharing needs separate recipient,
consent and rotation contracts and is not enabled here.

[Shared serialization](../../../../packages/shared/src/mcp-authentication.ts) rejects
new literal credentials at renderer and daemon writers. Legacy reads strip these values
and credential-bearing URL components without importing them into another user's vault.
Normalization does not erase raw CRDT history or make previously shared credentials
private again. Arbitrary secrets in command arguments or URL paths cannot be detected
reliably; authentication must use credential fields or environment references.

## Runtime and interaction

[The native service](../../../../apps/cli/src/mcp/authentication/service.ts) owns
attempts, serialized refresh and per-runtime relay scopes. Its
[I/O adapter](../../../../apps/cli/src/mcp/authentication/io.ts) uses the locked MCP
client SDK 2.0.0. A deprecated Promise facade bridges SessionManager/local RPC; the
surrounding Session lifecycle remains Legacy. Sessions retire before service shutdown.

Detection requires an actual 401 Bearer challenge plus validated protected-resource
and issuer metadata. Plain 401, Cloudflare 403 and network failures do not infer an
OAuth login. Settings reuse the MCP editor with an explicit Settings entry and Sign-in
and authorization section. Saving/checking never opens the browser. An explicit action
after saving starts PKCE S256 with a state-validated, single-use loopback callback.
Network steps have finite deadlines; attempts expire after ten minutes. Cancellation
joins callback cleanup and fences late replies/codes; cancelling a replacement attempt
preserves an earlier sign-in. Optional client fields support pre-registered clients,
without promising arbitrary bespoke login. The rejected scope helper line is omitted.

Manual secrets are separated from shared form values and sent only through capability-
gated local Machine RPC, never a remote fallback. Secret fields do not read back tokens.
`@napi-rs/keyring` uses Keychain, Credential Manager or Linux Secret Service. Missing or
locked secure storage reports failure without plaintext fallback. Anonymous services
work without a secure-store backend; OS interaction still needs platform acceptance.
Sign-out closes local connections and deletes the local record. Provider-side consent
revocation is not implemented.

HTTP relays bind selected entry, exact runtime instance and requester. Agents receive
random local capabilities. The relay rejects Origin/foreign Host; Linux also proves
peer uid with the existing full socket-tuple lookup. It preserves GET/SSE streaming,
bounds bodies/queues, uses four workers, rejects redirects and redacts provider error
bodies. Retirement/sign-out close endpoints, and late startup cannot recreate a retired
owner's connection. Stdio credentials go only into the selected process environment.
Changing the requester retires MCP-bearing Sessions before another human reuses them.
Refresh rotation is serialized, and replacement records become durable before reuse.
Browser codes/verifiers remain attempt-local; UI status contains no tokens.

## Evidence and limits

Synthetic tests exercise the real SDK authorization-code/PKCE and refresh flow,
callback state/replay/refusal, cancellation and late UI replies, target/principal
isolation, relayed credentials/header filtering, local-only RPC, shared-write rejection
and legacy normalization. Existing discovery and Session lifecycle suites also run;
final commands/results belong to the task report. HTTP, listener and vault ports are
injected; tests do not contact live providers.

Earlier public [Slim Tools metadata](https://slim.tools/.well-known/oauth-authorization-server)
advertised registration, authorization-code/refresh grants and S256. A later Python
initialize probe returned Cloudflare 403 without an OAuth challenge. No real account
consent, authenticated Slim call or production token persistence was performed.
[Magpie](https://github.com/yetone/magpie/blob/main/internal/mcpauth/mcpauth.go) was a
reference for local custody/relaying, not proof of universal compatibility. Standards:
[RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html),
[MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

The isolated checkout reuses installed dependencies and pinned metadata for uninitialized
ACP submodules. Required context/local-agent-ownership.md and context/message-flow.md
are absent in this revision; current scoped contracts and identity/peer-uid code supplied
the available evidence. Remote callback management, OS acceptance, provider revocation
and credential sharing remain outside this implementation. Draft PR: [#1938](https://github.com/LodyAI/Lody/pull/1938).

The independent authorization view was rendered with a minimal Storybook wrapper;
required, unsaved, waiting and authorized states were checked in-browser. The full
shared Storybook shell hit an existing Loro WASM initialization error in this
symlinked dependency checkout; this is not a full Electron smoke test.

On the latest-main PR base, 40 CLI authentication/discovery/configuration/selection,
81 component and 46 shared tests passed (167 total). Shared typecheck, scoped lint,
`pnpm format`, i18n and all eight boundary guards passed. Documentation check retains
six missing Kimi/Pi submodule links, with no new errors or protected topics.

Full `pnpm check` and CLI/components typechecks were attempted but remain blocked by
reused dependencies: missing newer E2EE/Streams packages and stale Roost/ACP APIs.
After loading current pinned ACP sources, three Session suites still fail during
module initialization because cached Claude SDK metadata is older than the runtime
manifest. Effect patch lint cannot load missing `@effect/tsgo`. Local Node 24.14.0 is
below latest main's runtime floor. Before rebasing, all three package typechecks and
157 focused tests passed; those results do not validate the newer dependency graph.
