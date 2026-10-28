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

## Encrypted dispatch

The encrypted workspace channel implements `session/dispatch-turn` using the
approved [E2EE foundations](../../specs/e2ee-foundations.md). Native hosts retain
signed purpose-8 requests and purpose-9 receipt ACKs before sending. Bodies and
ACKs are encrypted; only random correlation IDs and ciphertext enter Streams.
Complete sealed frames are limited to 1 MiB, including 143 bytes of overhead.
The resource is `rpc:<base64url(machineId)>`, with strict UTF-8 machine IDs.

`./e2ee-native` owns crypto and immutable SQLite originals in trusted hosts;
`./e2ee-streams` owns bounded shared readers and request correlation. The browser
uses narrow host preparation/response methods and never receives signing keys.
Preparation and ACK verification compare the parsed DTO's JSON wire representation,
so omitted optional fields reuse the saved original without changing its ID/frame.
An 800 ms acceleration deadline falls back to the encrypted history/Meta path.
Both paths use the same user turn and original frame; the CLI's existing
`agent-start:<userTurnId>` journal and current membership authorization decide
whether execution can start. A progress ACK confirms receipt, not execution.

Scope close aborts and drains raw reads before releasing tokens. One rejected
request does not stop the workspace. Originals and execution evidence are not
automatically collected. See the [implementation decision and validation limits](../../.agents/notes/implemented/architecture/2026-10-28-e2ee-streams-dispatch.md).

The pure codecs in `src/e2ee-wire.ts` also define nested error and presence
bodies; those codecs do not enable additional RPC methods or presence transport.

## Request deadlines

JSON appends keep a 10-second upload deadline by default. A configured
`timeout.connectTimeoutMs` also applies to appends unless
`timeout.uploadTimeoutMs` overrides it. The SDK's longer bulk-document upload
default does not change Machine RPC request deadlines.

Browser response readers using the live-mode policy renew their connection once
if an appended Roost input has no receipt after two seconds. This retains the
request and its deadline, works with existing daemons, and still requires a real
owner response before confirming delivery. Explicit transport pins disable it.

## Manual latency comparison

The synthetic [loopback benchmark](../../apps/cli/scripts/benchmark-e2ee-rpc.ts)
compares existing ordinary RPC with encrypted dispatch through real Streams,
crypto and SQLite journals. It records every send/append/receive/verify/claim stage.
Its final handler and authorization are fixtures; it does not measure real ACP
startup. Run it against an explicitly started HTTP/1 local dev gateway.

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

## Encrypted file and preview features

Encrypted workspaces route Code Collab, restricted file preview and preview controls
through the existing signed workspace RPC domain. The native host retains request
and response originals and validates all result pages before returning a complete DTO;
the renderer shares dispatch's response owner. Audited machine/file reads use that same
codec with read authority and no execution journal. See the
[read boundary](../../.agents/notes/implemented/architecture/2026-10-28-e2ee-read-queries.md). The format,
room boundaries and acceptance limits are recorded in the
[availability decision](../../.agents/notes/implemented/feature/2026-10-28-e2ee-file-preview-availability.md).
