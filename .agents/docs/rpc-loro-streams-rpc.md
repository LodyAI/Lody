# Loro Streams Machine RPC map

Internal map for `@lody/loro-streams-rpc`. The package `README.md` is the npm
front page and stays a user-facing document, so this directory index and the
cross-repository seam live here instead. Binding rules stay in
[`packages/loro-streams-rpc/AGENTS.md`](../../packages/loro-streams-rpc/AGENTS.md).

Workspace/machine-level JSON RPC over Loro Streams. Code Collab v2 uses it as
ordinary Machine RPC; the old session-scoped Code Collab Host RPC ingress has
been removed.

## File responsibilities

- `src/rpc.ts` — method schemas, request/response stream helpers, client transport,
  Code Collab v2 payload envelope helpers, request TTL/trace context, and typed
  request helpers.
- `src/live-mode-policy.ts` — SSE-first live transport selection with the bounded
  long-poll fallback and its diagnostics.
- `src/machine-rpc-server.ts` — CLI-side request loop and dispatch to machine/session
  handlers.
- `README.md` — package smoke-test notes.

`session/queue-steer` is an identity-based control operation, not queue reordering. Its
request names both the expected active turn and exact queued item, and callers require
`queueItemSteer` v2. Its paired `session/queue-mutate` domain RPC serializes revision-checked
edit/remove/reorder against reservation; conflicts fail visibly, without renderer direct-write
fallback. Native submission waits for durable history and queue removal.
The CLI accepts the item only when its
editing lease is inactive, then preserves native ACP Steer when acknowledged or creates an
ordinary follow-up before cancelling the expected turn. The ordinary path retains the queue
row until history and its activation pointer are durable. Missing, editing, and stale targets
do neither.
Before a remote renderer writes this control request, it fails closed against its authenticated
`machines:listVisibleMachines` snapshot. The retained request contains no requester identity:
the target daemon cannot authenticate such a claim and must not grant its owner fast path from it.
Native queue Steer instead inherits the frozen requester from the authenticated active invocation;
it fails before consumption when that identity is unavailable and never trusts the queue row.

## Remote lifecycle acknowledgements

For accepted restart/upgrade responses, `settleMachineLifecycleResponse` attempts
delivery for at most five seconds before invoking the CLI lifecycle callback.
Delivery failure is logged locally rather than turned into an operation error.
Rejected responses never invoke that callback. The existing CLI process boundary
owns its one-time shutdown guard; the RPC helper does not install or restart inline.
See the [draft ACK contract](../../specs/machine-lifecycle-ack.md).

## Code Collab seam

- Web creates/reuses `LoroStreamsMachineRpcClient` in
  `packages/components/src/providers/create-workspace-runtime.ts`, with one shared
  `LoroStreamsRpcResponseDispatcher` per workspace runtime.
- CLI wires v2 server handlers in `apps/cli/src/lib/message-handler.ts` to
  `apps/cli/src/lib/code-collab/code-collab-v2-service.ts`.
- Legacy v1 guest file operations and `session/code-collab-*` schemas are gone from
  this package. Local UI compatibility stubs live outside this transport.

## Why the live-read watchdog exists

The streams client (0.5.0) applies `connectTimeoutMs` only to the initial SSE
fetch and has no read timeout, so a server that holds the connection open
silently would hang forever — the documented "SSE stall, no watchdog" failure
class. A compliant server closes about every 60s and emits `up_to_date` on
connect, so the 120s default never fires on a healthy connection. The watchdog
aborts with a plain `AbortError` because any custom reason is read downstream as
a real error rather than a clean end of read.

Stable shard selection exists for the same kind of reason: a randomly picked
write shard re-runs the cross-origin CORS preflight on every append, while a
stable one reuses the warm connection and the cached preflight.

## Why `file/preview` sits outside `code-collab/`

Previewing a file must not activate Code Collab on the machine, so File Preview
v3 is its own method — but the requested path and returned bytes are still user
content, so it reuses the owner-session content envelope and owner verification.
The earlier `method.startsWith('code-collab/')` checks silently excluded any new
envelope method, which is why every encrypt/decrypt/error-decode site now goes
through `isOwnerScopedEncryptedRpcMethod`.
