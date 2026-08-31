# packages/loro-streams-rpc

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Repo-wide guidelines live in the root `AGENTS.md`.

Workspace/machine-level JSON RPC over Loro Streams. Code Collab v2 uses this as ordinary
Machine RPC; the old session-scoped Code Collab Host RPC ingress has been removed.

## Invariants

- Request stream ids are workspace/machine scoped:
  `getLoroMachineRpcRequestStreamId(workspaceId, machineId)` returns
  `<workspaceId>:rpc:req:<machineId>`.
- New Web runtime clients share one workspace-level response stream per runtime:
  `getLoroWorkspaceRpcResponseStreamId(workspaceId)` returns `<workspaceId>:rpc:res`,
  and the runtime appends `:<uuid>` before sending that exact stream id in each
  request `replyTo`.
- `getLoroMachineRpcResponseStreamId(workspaceId, machineId)` remains the legacy
  response stream base for direct `LoroStreamsMachineRpcClient` construction and
  old clients. Servers must continue to append to the request's `replyTo` and accept
  both response stream naming schemes.
- Method names live in `src/rpc.ts` `LoroStreamsRpcMethodSchema`; client convenience
  methods are on `LoroStreamsMachineRpcClient`.
- `createLoroStreamsJsonStreamClient` append selects its shard **stably** per stream id
  (`selectStableShardUrl`), not randomly: a given request/response stream always hits one
  host so the browser reuses the warm connection and keeps the cross-origin CORS preflight
  cached instead of re-preflighting a freshly-picked write shard on every append.
- `readJsonLive` wraps every live read in an idle watchdog
  (`liveIdleTimeoutMs`, default `DEFAULT_LIVE_IDLE_TIMEOUT_MS` = 120s; `0` disables).
  The streams client (0.5.0) applies `connectTimeoutMs` only to the initial SSE fetch and
  has **no read timeout**, so a server that holds the connection open silently would hang
  forever — the documented "SSE stall, no watchdog" failure class. On idle the watchdog
  aborts with a plain `AbortError` (a custom reason would be misread as a real error), so
  the live read returns cleanly and the caller's `while (!this.stopped)` loop
  (`runResponseLoop` / server `runLoop`) reconnects from the saved offset. A compliant
  server closes ~every 60s and emits `up_to_date` on connect, so the default never fires
  on a healthy connection.
- Web Machine RPC responses are **SSE-first with a bounded long-poll fallback**, owned by
  `LoroStreamsLiveModePolicy` (`src/live-mode-policy.ts`) and passed to
  `LoroStreamsRpcResponseDispatcher` as `liveModePolicy`; it picks the mode per read, so do
  **not** re-pin a static `liveMode` on the web json stream client. It falls back on
  unsupported SSE, consecutive failed reads, and pending-response starvation, and switches
  must preserve `responseState` offsets and the `pending` map. Read
  context/machine-rpc-live-transport.md
  before touching it — it carries the cf80d2c12 history and the exact fallback rules. The CLI
  request-read keeps the static client default (`'sse'`) plus the watchdog.
- The CLI owns/listens to the request stream via `src/machine-rpc-server.ts`
  `LoroStreamsMachineRpcServer`.
- The server dispatches requests **concurrently**, bounded by `maxConcurrentRequests`
  (default 16): a slow handler (e.g. a large turn diff) must not head-of-line block
  independent reads on the shared per-machine request stream. Handlers must therefore
  be safe to run concurrently; any handler that needs read-check-write atomicity
  serializes in its own service layer (e.g. Code Collab `save-text` is serialized
  per absolute path in `code-collab-v2-service.ts`), not by relying on the request loop.
- Control-plane methods (`machine/status`, `machine/ping`, `session/cancel`,
  `session/live-status`, `session/steer`, `session/terminate`, `machine/restart`,
  `machine/upgrade`, `session/dispatch-turn`)
  bypass the shared semaphore and run on a small dedicated lane
  (`CONTROL_METHODS` in `machine-rpc-server.ts`) so saturated code-collab
  handlers cannot delay them at intake. Control handlers must stay fast
  (ack-then-execute): `session/dispatch-turn` only stashes the payload and wakes the
  dispatch watcher — never run the agent turn inside the handler. Its `expiresAt`
  is deliberately short (== client timeout, ~15s) because a server restart replays
  the request stream from offset `'-1'`.
- Session orchestration authorization is checked source-side with the source CLI
  token because workspace RPC cannot authenticate a claimed requester identity.
  `session/live-status` reads the target
  daemon's active-presence controller and must not infer liveness from durable
  `SessionMeta.status` or message pointers.
- Remote daemon lifecycle details live in
  context/machine-lifecycle.md. RPC handlers
  must not run installers inline; they ACK and let the CLI process boundary exit.
- `machine/acp-capabilities-refresh` and `machine/acp-binary-install` may append
  `machine/acp-binary-progress` result envelopes before the final response. The
  response dispatcher must call the progress callback and keep the pending request
  open until the final method response or error envelope arrives. Capability refresh
  request/response context and client pending correlation are keyed by `configId`.
- Capability refresh cancellation uses the control-lane
  `machine/acp-capabilities-refresh-cancel` method keyed by the original RPC id. Client
  abort, response timeout, and response-dispatcher stop/owner cancellation all discard
  that exact pending entry and, once the original request was appended, best-effort append
  one cancel request. A pending request must return at its response deadline even if the original
  append POST is still half-open; if that append later succeeds, append the cancel then. The server
  must abort that request's work and suppress all later
  progress/final envelopes; a cancel for one shared CLI probe consumer must not abort other
  consumers of the same launch/config work.
- `machine/acp-authenticate` similarly may append
  `machine/acp-authentication-progress` envelopes before its final response. Progress
  output must not resolve or remove the pending authentication request. Browser-returned
  codes, method/form replies, and other authentication input must never appear in retained
  request JSON: the target server advertises an ephemeral ECDH public key in progress, the
  client persists only an AES-GCM envelope bound to the authentication request and interaction,
  and the server decrypts only in target-process memory. Redact plaintext and encrypted input fields
  from invalid-request logging. Generic interaction keys appear only on the versioned method/form/
  URL-consent progress shapes; built-in code submission keeps its old progress shape so strict older
  clients still accept it. Custom/Registry ACP authentication stays on that same long-running request
  so method selection, URL/form elicitation, cancellation, and timeout all target the temporary ACP
  process that owns the login.
- Code Collab v2 file/LSP methods are ordinary Machine RPC methods:
  `code-collab/open-text`, `refresh-text`, `save-text`, `init-directory`,
  `open-current-diff`, `open-turn-diff`, `lsp-definition`, and `lsp-references`.
  They carry workspace-relative paths, never per-file ids.
- Remote Streams transport wraps Code Collab request params, success results, and
  business error `data` in a v2 owner-session content-key envelope. The business
  schemas stay unchanged; `ownerSessionId` is transport metadata and child sessions
  use the parent owner key.
- The CLI server validates the envelope owner against the business `sessionId`'s
  resolved owner session before dispatching Code Collab handlers; mismatches return
  `permission_denied` and must not call the file operation.
- Session-scoped Code Collab RPC methods are not part of this transport. Add v2 work
  under the ordinary `code-collab/*` machine methods.
- `file/preview` (File Preview v3) is a Machine RPC method OUTSIDE the `code-collab/`
  namespace, on purpose: previewing a file must not activate Code Collab on the
  machine. It reuses the same owner-session content envelope and the same owner
  verification, because the requested path and returned bytes are user content and the
  owner binding is the authorization. Every encrypt/decrypt/error-decode site must go
  through `isOwnerScopedEncryptedRpcMethod` — the previous
  `method.startsWith('code-collab/')` checks silently excluded any new envelope method.

## File Responsibilities

- `src/rpc.ts` — method schemas, request/response stream helpers, client transport,
  Code Collab v2 payload envelope helpers, request TTL/trace context, and typed
  request helpers.
- `src/live-mode-policy.ts` — SSE-first live transport selection with the bounded
  long-poll fallback and its diagnostics.
- `src/machine-rpc-server.ts` — CLI-side request loop and dispatch to machine/session
  handlers.
- `README.md` — package smoke-test notes.

## Code Collab Seam

- Web creates/reuses `LoroStreamsMachineRpcClient` in
  `packages/components/src/providers/create-workspace-runtime.ts`, with one shared
  `LoroStreamsRpcResponseDispatcher` per workspace runtime.
- CLI wires v2 server handlers in `apps/cli/src/lib/message-handler.ts` to
  `apps/cli/src/lib/code-collab/code-collab-v2-service.ts`.
- Legacy v1 guest file operations and `session/code-collab-*` schemas are gone from
  this package. Local UI compatibility stubs live outside this transport.
