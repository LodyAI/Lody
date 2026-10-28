# packages/loro-streams-rpc

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Repo-wide guidelines live in the root `AGENTS.md`.

Machine RPC contracts: [transport map](../../.agents/docs/rpc-loro-streams-rpc.md).

## Invariants

- Encrypted dispatch retains exact frames across retry/fallback. Receipt ACK never
  completes the shared execution claim. [Ownership/close](README.md#encrypted-dispatch).
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
- JSON append timeout: `uploadTimeoutMs ?? connectTimeoutMs ?? 10000`; keep
  RPC deadlines independent of bulk uploads.
- `readJsonLive` keeps `liveIdleTimeoutMs` (default 120s; `0` disables) and aborts
  with plain `AbortError`, so `runResponseLoop` / `runLoop` resume saved offsets.
- Web Machine RPC responses are **SSE-first with a bounded long-poll fallback**, owned by
  `LoroStreamsLiveModePolicy` (`src/live-mode-policy.ts`) and passed to
  `LoroStreamsRpcResponseDispatcher` as `liveModePolicy`; it picks the mode per read, so do
  **not** re-pin a static `liveMode` on the web json stream client. It falls back on
  unsupported SSE, failed reads and response starvation. Appended Roost input writes
  renew the shared response read once after 2s; retain offsets, pending calls and
  deadlines, never replay the write or infer acceptance. Stop/cancel removes that
  recovery; explicit pins disable it. Read the linked Machine RPC map before changes.
  CLI request reads keep static `'sse'` plus the watchdog.
- The CLI owns/listens to the request stream via `src/machine-rpc-server.ts`
  `LoroStreamsMachineRpcServer`.
- Handler permits wait inside tracked tasks, never behind ordinary intake. Bound
  ordinary admission (default 128); overload replies are separately bounded.
  History writes and `CONTROL_METHODS` have reserved pools, independent of reads.
  Serialize mutations in their owner service, not the request loop.
  `session/history-watch` retains owner encryption and readiness checks. Bound its
  separate admission at 128; checkpoint waits hold no ordinary read permit. Acquire
  that permit only for the subsequent body/change read. Stop aborts parked waits.
- Control handlers stay fast: `session/dispatch-turn` stashes/wakes, never executes
  an agent inline. Its TTL equals the client deadline, bounding restart replay.
  Stop fences queued handlers; retain started work until its raw completion.
- History writes require durable precondition-refusal retention before replying.
  Replayed IDs keep that refusal until expiry; conflicting ID reuse and unavailable
  request state fail closed. Details: [history readiness](../../.agents/docs/rpc-loro-streams-rpc.md#history-readiness-and-error-provenance).
- Session orchestration authorization is checked source-side with the source CLI
  token because workspace RPC cannot authenticate a claimed requester identity.
  `session/live-status` reads the target
  daemon's active-presence controller and must not infer liveness from durable
  `SessionMeta.status` or message pointers.
- Remote lifecycle: [ACK contract](../../specs/machine-lifecycle-ack.md).
  RPC handlers never run installers inline. Accepted work exits via the CLI process
  boundary after a bounded ACK attempt, including delivery failure or timeout.
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
