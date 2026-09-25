# apps/cli/src/preview

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Managed preview tunnels and the local proxy. [apps/cli/AGENTS.md](../../AGENTS.md) applies.

- Quick Tunnel replacement is in progress; target contract:
  [Quick Tunnel preview](../../../../specs/quick-tunnel-preview.md).
  `preview-http.ts` owns shared target/path guards, header conversion and optional
  HTML injection; these helpers must not depend on a transport implementation.
- `cloudflared-manifest.json` is the only version/checksum source. The binary helper
  uses the public runtime channel and verifies cached executables; never discover
  PATH binaries. Bundle the matching generated license/notice texts and install
  `THIRD_PARTY_NOTICES.txt` alongside the executable atomically; incomplete caches
  fail explicitly. See [notice maintenance](README.md).
  Audit every distinct artifact's Go version and CGO setting. A release can use
  multiple toolchains; include each runtime/vendor notice set, not only the host's.
  `cloudflared-process.ts` owns the IPC lifecycle child; `cloudflared-worker.ts`
  runs `cloudflared-native.ts`, which owns the isolated config and native child.
  Normal shutdown uses IPC so cleanup errors can return; IPC disconnect also
  triggers cleanup after CLI death. No polling, restart policy or PID registry.
  Never kill the lifecycle child as a normal shutdown shortcut. Wait for its OS
  exit; it first reaps cloudflared and removes its config. Keep the Node child's
  `ELECTRON_RUN_AS_NODE`, but never pass Lody credentials or supervisor tokens.
  All CLI builds emit a sibling `cloudflared-worker.js`; no source-loader fallback.
  Native logs use the pinned release's `--output json`.
  Allocating an origin is not readiness. Public probes do not renew idle time.
  Status reads check active public routes within five seconds; concurrent reads
  share a probe. Unlike startup readiness, health failures are not retried: fail
  and clean up this endpoint, never a replacement created while the probe awaited.
- `PreviewService` now creates only `QuickTunnelSession` remote owners. The owner
  releases its proxy and child on cancellation, failed readiness, idle expiry or
  process exit. Its `closed` result is a cleanup barrier, not just a signal sent.
  Lifecycle writes are serialized per Session; revoke cancels acquisition before
  joining that queue. One-hour activity deadlines stay in memory. Machine slots
  span workspaces in the singleton Worker, never a PID registry on disk.
- Remote create/revoke/status must pass `authorizeRemoteControl` before touching
  endpoint state. Workspace RPC does not authenticate a claimed user id. Its
  short-lived signed proof binds the exact command and runtime nonce; the authority
  consumes each request id once, including concurrent duplicates. Verify project
  access from CLI-resolved metadata, never a caller-supplied project. Local controls
  use the trusted local route without cloud authorization; no remote fallback.
- Endpoint capabilities are checked on every HTTP request and WS upgrade. There
  is no global unlock: a matching Origin/tokenless Referer never grants access.
  Local and remote listeners use different random tokens; remote token cookies
  are Secure, HttpOnly, SameSite=None and Partitioned. A remote viewer origin must
  be explicitly bound, never inferred from Host or forwarded headers.
- A WS upgrade is acknowledged only after the upstream selects its subprotocol.
  Preserve text/binary frames and close shape; use socket backpressure, not an
  unbounded pre-handshake frame queue. Closing an endpoint invalidates it before
  aborting all owned HTTP requests, upstream WS and accepted sockets.

- Node fetch overwrites navigation `Sec-Fetch-Mode` with `cors`. The shared HTTP
  header builder removes browser Fetch Metadata only for navigation requests;
  preserve subresource metadata and foreign/opaque/missing Origin so cross-site
  resource/CSRF checks still apply. Only the exact explicitly bound viewer Origin
  maps to the approved local Origin, for HTTP and WS alike; never derive this
  mapping from Host or forwarded headers. Test through real HTTP/WS boundaries.

- Annotation is optional: probe proxy reachability independently of runtime injection.
  Preserve valid page bytes when injection alone would exceed the response limit.
- A streaming response failure must cancel its upstream body before releasing the
  reader lock. Lock release alone leaves unfinished origin responses alive.

- Preview targets are untrusted, and a managed preview reaches THIS machine's loopback and
  nothing else — agent candidate or user-approved alike, there is no policy under which a LAN
  host is accepted (`normalizeTarget` in `preview-service.ts`). The tunnel makes this machine the
  origin of whatever it connects to, so a LAN target would turn it into a pivot into its own
  network for a remote workspace member or an agent that talked them into a click; the approver
  cannot see what a LAN address here even is. Clients never send one, but this check must hold for
  any client.
- Loopback means a literal address or the exact name `localhost`. `classifyBrowserHostname` reads
  the hostname text, so any `*.localhost` name passes it while a search domain or rebinding record
  can point that name at a LAN host.
- `preview-target-transport.ts` binds probes and forwarding to the same literal loopback
  address, retaining the approved Host/TLS identity. HTTP uses an endpoint-owned Undici Pool
  and WS the same fixed lookup; ambient DNS and global HTTP proxies cannot retarget it.
  Closing an endpoint also destroys its dispatcher. IPv4/IPv6-only localhost services
  must both work without changing the user's listener configuration.
- Still require a fresh approval from the session initiator, and validate path-relative targets
  here.
- The local preview proxy must never forward an OBSERVED WebSocket close code into a Close frame.
  RFC 6455 reserves 1005/1006 for local observation, so `ws` throws from a TCP callback and kills
  the CLI with the active Agent session. Mirror the shape instead (`mirrorWebSocketClose` in
  `local-preview-proxy.ts`): `terminate()` for 1006, code-less `close()` for 1005. Both
  directions, plus the local-socket `error` handler, which must not pre-empt that mirror once the
  connection is open.
