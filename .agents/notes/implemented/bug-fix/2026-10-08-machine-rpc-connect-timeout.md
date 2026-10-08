# Default the Machine RPC Streams connect timeout to 30 seconds

Status: implemented
Translation: current

[中文](2026-10-08-machine-rpc-connect-timeout.zh.md)

## Abstract

Desktop Machine RPC passed no timeout, so `@loro-dev/streams-client` 0.8.0 gave token
resolution and the append POST 10 seconds each, while the CLI waits 30
([#1311](https://github.com/LodyAI/Lody/issues/1311)). `createLoroStreamsJsonStreamClient`
now defaults `connectTimeoutMs` to 30 seconds, so every caller gets the CLI's value
unless it passes its own. All callers are Machine RPC. A desktop-only fix would also
work, but a later caller without a timeout would fall back to 10 seconds again. The CLI
uses the same `DEFAULT_LORO_STREAMS_RPC_CONNECT_TIMEOUT_MS` as its
`LODY_LORO_RPC_CONNECT_TIMEOUT_MS` fallback. The desktop
ignores that variable because nothing passes it to the renderer.

## Limits

Desktop response reads now match the CLI: the first SSE request waits up to 30 seconds,
long-poll requests up to 60 instead of 40, and the SDK reconnects an idle SSE stream
after 60 seconds instead of 45. Nobody has tried the desktop menu against a stalled
Streams gateway.
