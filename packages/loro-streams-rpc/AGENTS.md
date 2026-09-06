# packages/loro-streams-rpc

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Repo-wide guidelines live in the root `AGENTS.md`.

Workspace/machine-level JSON RPC over Loro Streams. File responsibilities, the
Web/CLI Code Collab seam, and the reasons behind the watchdog, shard selection,
and the `file/preview` namespace are in
[the Loro Streams Machine RPC map](../../.agents/docs/rpc-loro-streams-rpc.md).

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
- `createLoroStreamsJsonStreamClient` append must select its shard **stably** per stream
  id (`selectStableShardUrl`), never randomly.
- `readJsonLive` must keep its idle watchdog (`liveIdleTimeoutMs`, default
  `DEFAULT_LIVE_IDLE_TIMEOUT_MS` = 120s; `0` disables) and must abort with a plain
  `AbortError`, so the caller's `while (!this.stopped)` loop (`runResponseLoop` /
  server `runLoop`) reconnects from the saved offset.
- Web Machine RPC responses are **SSE-first with a bounded long-poll fallback**, owned by
  `LoroStreamsLiveModePolicy` (`src/live-mode-policy.ts`) and passed to
  `LoroStreamsRpcResponseDispatcher` as `liveModePolicy`; it picks the mode per read, so do
  **not** re-pin a static `liveMode` on the web json stream client. It falls back on
  unsupported SSE, consecutive failed reads, and pending-response starvation, and switches
  must preserve `responseState` offsets and the `pending` map. Read
  context/machine-rpc-live-transport.md
  before touching it. The CLI request-read keeps the static client default (`'sse'`) plus
  the watchdog.
- The CLI owns/listens to the request stream via `src/machine-rpc-server.ts`
  `LoroStreamsMachineRpcServer`.
- The server dispatches requests **concurrently**, bounded by `maxConcurrentRequests`
  (default 16), so a slow handler cannot head-of-line block independent reads on the
  shared per-machine request stream. Handlers must be safe to run concurrently; one that
  needs read-check-write atomicity serializes in its own service layer (Code Collab
  `save-text` per absolute path in `code-collab-v2-service.ts`), not in the request loop.
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
  Version 2 binds every process-launching authentication/capability request to a
  daemon-resolved persisted `configId`. Start requests never carry launch fields;
  cancel/code/form replies carry only the established authentication request and
  interaction ids. Do not reintroduce caller-supplied `customAcp`, `env`, or runtime
  overrides on Workspace Machine RPC: that transport cannot authorize a caller to
  choose a command for the target daemon.
- Code Collab v2 file/LSP methods are ordinary `code-collab/*` Machine RPC methods
  (`open-text`, `refresh-text`, `save-text`, `init-directory`, `open-current-diff`,
  `open-turn-diff`, `lsp-definition`, `lsp-references`). They carry workspace-relative
  paths, never per-file ids.
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
  verification. Every encrypt/decrypt/error-decode site must go through
  `isOwnerScopedEncryptedRpcMethod`.
