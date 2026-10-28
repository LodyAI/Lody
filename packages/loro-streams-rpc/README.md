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

## Candidate E2EE body codecs

`src/e2ee-wire.ts` implements the candidate M5 request, response, nested error
and presence plaintext layouts from [the wire draft](https://github.com/LodyAI/Lody/pull/1894).
The codecs are pure and introduce no transport, keys, persistence or execution.
Normal workspace RPC keeps its existing envelopes. The exact profile still
requires owner review before product adoption; see the
[decision and integration limits](../../.agents/notes/proposed/architecture/2026-10-28-e2ee-realtime-body-codecs.md).

RPC bodies reserve content v0's 143-byte overhead inside a complete 1 MiB frame.
Presence bodies have a 64 KiB limit and positive TTL at most 60 seconds. These
limits are checked before output allocation or copying decoded byte fields.
Lengths and integers use unsigned big endian; unsafe u64 values, unsupported
versions/kinds, truncation, trailing bytes and invalid ASCII fields are rejected.
Method bytes stay opaque and are never parsed or reserialized here.

Use decoders only after authenticating the content frame. The caller owns and
wipes returned bytes and separately verifies the workspace/target/signer/epoch,
method DTO, current permissions, execution freshness, request digest and response
sequence state. Presence additionally needs room binding, replay checks and
`issuedAt <= now < expiresAt`. Retry sends the retained sealed frame; encoding
another body never supplies permission to re-sign or repeat an action.

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
The codec landed on main at `c7b3c715` and is consumed directly; it is not duplicated.
Local key/ledger access failure returns an explicit unavailable outcome, whereas
invalid remote frames return null. A joined transport cannot turn unavailable
crypto into a definite offline result. `makeEncryptedPresence` validates bounded existing
liveness DTOs, derives machine/viewer authority from the current ledger, limits
validity to 60 seconds, and keeps bounded per-receiver replay floors through expiry.
Document synchronization and ordinary RPC are independent. See the
[decision](../../.agents/notes/proposed/architecture/2026-10-28-encrypted-ephemeral-presence.md)
for transport ownership and remaining acceptance limits.
