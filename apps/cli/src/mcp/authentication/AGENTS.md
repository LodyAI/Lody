# Local MCP authentication

Parent rules apply. Lifecycle background: [../README.md](../README.md#local-authorization).

- `service.ts` owns attempts, serialized credential rotation and session relay scopes
  in native Effect. Execute only through the explicitly deprecated `legacy.ts` facade
  until Session/RPC callers migrate; no second kernel or module-global owner.
- Store credentials only in the OS vault, keyed by local account, machine, workspace
  and MCP entry; bind applicability to the connection and SDK issuer/client identity.
  Never persist them in shared documents, telemetry, session history or Agent HTTP config.
- Authentication RPC is local-only and capability-gated. Never substitute the daemon
  owner's authorization for another human. Retire MCP-bearing Sessions on requester change.
- Detect OAuth from an actual Bearer challenge and validated resource/issuer metadata.
  The browser opens only on explicit UI authorization. Callback state, PKCE and single-use
  codes must survive neither cancellation nor expiry; join owned callback cleanup.
- Relays bind the selected entry and exact runtime instance. Require a random capability,
  reject Origin/foreign Host, and on Linux prove peer uid. Unlike the built-in MCP host,
  these relays preserve upstream GET/SSE. Bound queues, bodies and cleanup, reject
  redirects, redact upstream failures, and close on retirement or local sign-out.
- No plaintext storage fallback, remote credential management, automatic legacy import,
  or credential sharing. E2EE sharing requires its own reviewed contract.
- Tests inject SDK HTTP, callbacks, clocks and vault ports; never contact live OAuth services.
