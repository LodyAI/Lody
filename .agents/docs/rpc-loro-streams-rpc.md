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

## Request scheduling

Ordinary handlers have a shared execution pool (default 16) and bounded admission
(default 128, including active tasks). History writes, including immutable input
acceptance, have four reserved execution slots; control methods have four more.
Each foreground pool admits at most 128 active/queued tasks. Batch intake examines
control and write requests first and acquires handler permits inside tracked tasks.
A full ordinary pool never waits at intake: excess requests get a protocol busy
response through another bounded four-slot pool. At most 128 busy responses are
retained; further overload is logged and left to the caller's timeout/recovery.
No overload result proves the outcome of an earlier duplicate dispatched write.

Local Electron history reads instead use their own pool (at most eight active
sessions) in `MessageProcessor`. Writes remain ordered on the session writer lane.
Remote RPC calls the history handlers directly. Stop prevents queued handlers from
starting; already-started raw work retains its task/permit until it settles.
[Incremental recovery and scheduling decision](../notes/implemented/bug-fix/2026-10-16-roost-incremental-history.md)
records boundary tests and limits; none is a live-service latency measurement.

`session/history-watch` is an independently negotiated, owner-encrypted read method.
It admits at most 128 parked requests in a separate lane; MessageHandler also caps
owner waits across transports at 128. The checkpoint wait lasts at most 15 seconds
outside ordinary permits, SQLite execution and writer serialization. After publication
or deadline, its change/body read acquires an ordinary permit. The client response
budget is 45 seconds. Local watches use independent wait lanes and a bounded
post-wake read pool; one viewer cannot park another viewer behind its same-session wait.
Stop aborts parked waits and fences queued work. The existing dispatcher retains raw
reads through settlement; it never interprets waiter cancellation as write rollback.
See [peer observation](../notes/implemented/bug-fix/2026-10-16-roost-peer-reader-readiness.md).

## History readiness and error provenance

History RPC verifies session identity, owning machine and the persisted Roost backend
before opening storage. Its CLI readiness kernel subscribes and snapshots at one Repo
boundary; missing/partial metadata waits for that session only, with a ten-second
deadline and cancellation on shutdown. Confirmed foreign/deleted owners fail immediately.
This handles metadata and request streams arriving independently without a Repo-wide flush.

History failures projected by the client retain `rpcFailure` provenance, code, request
ID and target machine. It is a client-only field, never part of an encrypted history
result. Request append failures and response timeouts are transport failures with
potentially unknown write outcomes; the renderer does not send users to owner-local
storage logs for them. Owner storage errors keep their existing safe diagnostic string.
Server metadata refusals keep a stable RPC error code and log request-correlated,
content-free ownership context. No failure authorizes replay or backend fallback.

The request stream can replay unexpired requests after server restart. The CLI saves
history precondition refusals in a separate machine-local SQLite store before replying,
then returns that saved refusal on replay even if metadata became ready. Records bind
workspace, machine, request ID and a hash of the complete request; they contain no history
payload or credentials and expire with the original request. A new request ID can retry.
Writable history requires this injected store, and lookup/save failures fail closed.
Identical concurrent history requests share one handler; conflicting reuse of an ID is
rejected. Expiry and server stop are checked again after metadata readiness, before
history handoff. Dispatched write outcomes retain their existing recovery policy.

`sessionInputAcceptance` version 1 adds `accept_input` and the read-only
`inputAcceptance` query. The source keeps the original prepared input and target;
the owner binds its immutable fingerprint to the history mutation atomically.
An absent query result remains unknown, but delivering that identical input
again is safe because the receipt wins over current placement. The CLI searches
retained history generations before accepting it, including receipts for removed
history. Request IDs can change; input IDs and content cannot. This capability
does not grant history access, confirm execution, or permit steer replay.

Ordinary input additionally negotiates `sessionInputDispatch` version 1 for
`accept_input_and_dispatch`. The owner records trusted human provenance, accepts
immutable history and publishes guarded activation in its existing writer queue;
the host wakes its history dispatcher without waiting for Agent execution. The
source uses this receipt for delivery feedback without history readback or another
dispatch request. Recovery repeats the same immutable combined operation, retaining
the existing identity, membership and metadata guards. Plain acceptance and guide
application keep their separate contracts. See the
[owner protocol](../../apps/cli/src/session/README.md#immutable-input-acceptance).

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

### Foreground input receipt recovery

The browser dispatcher also renews a response read when an appended
`accept_input`/`accept_input_and_dispatch` has no response after two seconds.
The shared live-mode policy moves SSE to long-poll; a stalled long-poll connection
is renewed too. One timer covers overlapping inputs and each pending input gets
one renewal. Normal replies, request deadlines, owner cancellation and dispatcher
stop remove the timer. Explicit transport pins and static-policy clients retain
their existing behavior; idle history watches do not arm this recovery.

Renewal preserves the response offset, request IDs and original RPC deadlines.
It never re-appends input, confirms delivery or needs a new daemon protocol. A
slow owner still has to produce a real receipt. Two seconds is a recovery trigger,
not a delivery bound or evidence that SSE caused a particular delay. A normal
owner taking longer can also trigger long-poll and its CORS cost for the existing
five-minute SSE cooldown. [Evidence and limits](../notes/proposed/bug-fix/2026-10-18-roost-remote-receipt-latency.md).

## Why `file/preview` sits outside `code-collab/`

Previewing a file must not activate Code Collab on the machine, so File Preview
v3 is its own method — but the requested path and returned bytes are still user
content, so it reuses the owner-session content envelope and owner verification.
The earlier `method.startsWith('code-collab/')` checks silently excluded any new
envelope method, which is why every encrypt/decrypt/error-decode site now goes
through `isOwnerScopedEncryptedRpcMethod`.
