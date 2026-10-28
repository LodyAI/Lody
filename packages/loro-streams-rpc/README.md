# `@lody/loro-streams-rpc`

Machine RPC transport over Loro Streams, built on the JSON-stream adapter from
`@loro-dev/streams-client`.

The package owns:

- Machine RPC request/response stream naming. Requests use
  `<workspaceId>:rpc:req:<machineId>`. New web runtimes share a
  `<workspaceId>:rpc:res:<uuid>` response stream; the legacy
  `<workspaceId>:rpc:res:<machineId>:<uuid>` form remains supported.
- RPC envelope schemas and validation.
- The JSON stream client.
- The web RPC client.
- The CLI RPC server.

## Request deadlines

JSON appends keep a 10-second upload deadline by default. A configured
`timeout.connectTimeoutMs` also applies to appends unless
`timeout.uploadTimeoutMs` overrides it. The SDK's longer bulk-document upload
default does not change Machine RPC request deadlines.

Browser response readers using the live-mode policy renew their connection once
if an appended Roost input has no receipt after two seconds. This retains the
request and its deadline, works with existing daemons, and still requires a real
owner response before confirming delivery. Explicit transport pins disable it.

## Development

```bash
pnpm typecheck
pnpm test
pnpm test:watch
```

## Integration tests

The default `pnpm test` command does not start a local Loro Streams development
server. Run the real request/response round trip with:

```bash
pnpm test:integration
```

The integration command starts a local server through `loro dev --db-path ...` and
then runs the transport tests against it.

## Encrypted ephemeral presence

The host-only `@lody/loro-streams-rpc/encrypted-presence` entry composes purpose-7
crypto with the presence body codec from [#1990](https://github.com/LodyAI/Lody/pull/1990).
That dependency is locally overlaid for validation until it lands on main; its
codec is not duplicated here. `makeEncryptedPresence` validates bounded existing
liveness DTOs, derives machine/viewer authority from the current ledger, limits
validity to 60 seconds, and keeps bounded per-receiver replay floors through expiry.
Document synchronization and ordinary RPC are independent. See the
[decision](../../.agents/notes/proposed/architecture/2026-10-28-encrypted-ephemeral-presence.md)
for transport ownership and remaining acceptance limits.
