# iOS Simulator

`CLAUDE.md` is a symlink to this file. CLI ancestor rules apply.

- `service.ts` owns ephemeral workspace/session preview operations; `control-leases.ts`
  is the machine Worker singleton that excludes other sessions across workspaces.
  Acquire before boot/download, revoke inputs and join cleanup before release. A stale
  operation must never release a replacement lease. Do not persist devices, frames,
  connection credentials, or heartbeats in Repo metadata.
- `devices.ts` owns simctl listing/boot; `host-controls.ts` owns fixed device controls.
  Validate foreign JSON and UDIDs; invoke argv directly. Listing never downloads a runtime, starts devices or opens a tunnel.
- `gateway.ts` exposes only the fixed viewer, bound device stream and typed private
  control endpoint. It is behind the authenticated preview proxy; never forward arbitrary Baguette routes or
  messages. Validate every input and active lease. Frames/status probes do not renew
  idle expiry; only explicit viewer heartbeat or valid input does.
- `device-controls.ts` maps the shared control union to fixed loopback routes. Text
  uses `host-controls.ts` to write the device clipboard, then sends acknowledged Cmd-V.
  The IPC worker directly owns fixed simctl/devicectl commands for text, appearance,
  shake and deep links; abort joins child close before release. Do not delegate these to
  Baguette's Foundation.Process paths: those children create separate process groups
  and can outlive the native server. Control bodies/errors never enter logs or RPC.
  iPhone/iPad preparation disables device-local `AutomaticMinimizationEnabled` and
  notifies keyboard preferences so the guest software keyboard remains available.
  Never rewrite host-global Simulator preferences or reboot to change keyboards.
  Negotiate `iosSimulatorControls: 1`.
- `exterior.ts` reads only the bound device's fixed definition/bezel routes, strips all
  upstream URLs, and validates geometry plus bounded PNG dimensions. The gateway serves
  these behind the same private capability; resource reads never renew the lease.
  The separately negotiated `exterior {udid}` read uses fixed `chrome layout/composite`
  CLI arguments without boot, lease or server. Its bounded static artwork (256 KiB PNG)
  may cross authenticated RPC; never include screen pixels, paths or capabilities.
  Serialize reads, bound the in-memory cache, and recheck authorization before replying.
- `frame-flow.ts` owns sequenced JPEGs, cumulative receiver credit and the latest-only
  pending frame. Keep both frame/byte windows bounded; a local socket's bufferedAmount
  is not receiver backpressure. ACK/config/probe traffic never renews the lease.
  `viewer-media.ts` owns RAF decoding, bounded numeric diagnostics and move coalescing;
  preserve touch-up/final coordinates and cancel scheduled work on disconnect.
  Remote pacing/byte credit use conservative payload completion and minimum RTT;
  congested RTT must not expand credit. Scale combines viewport/SOF with network
  feedback, capped at 4; never forward arbitrary native reconfiguration. Recover
  quality slowly and keep browser sampling independent of queued gateway reports.
  Native MJPEG FPS remains unfixed. `idle-refresh.ts` owns one bounded sharp JPEG
  after a drained quiet period; input/source changes revoke pending stills, and
  disconnect joins cancelled capture. Fixed loopback capture never renews a lease.
- `viewer.ts` is the fixed iframe artifact, without React or annotation injection.
  Parent commands bind source, origin and operation id. Decode at most one JPEG
  with one replaceable pending frame; release touches on blur/cancel/disconnect.
  Wheel/trackpad scrolling synthesizes the same single-touch protocol; it must
  release on idle and before pointer takeover, without widening the gateway allowlist.
  Pointer gestures starting in the bottom 7% retain `edge: bottom` until release.
  The gateway accepts only that edge, validates its start band and rejects changes
  mid-gesture; disconnect cleanup preserves the edge on the final touch-up.
  Capture transfers bounded PNG bytes only to the exact parent that requested it;
  never send pixels through state messages. The authenticated init selects mobile
  upright display or desktop device-following rotation. Display angle consistently
  controls layout, pointer mapping and capture; native device rotation stays independent.
- `baguette-worker.ts` owns the native process through an IPC lease. Owner loss must
  reap it and join pending host controls; never terminate the worker as normal cleanup. All build compositions emit
  the same sibling worker entry. No user simulator is shut down during cleanup.
- Keep Baguette version, artifact digest and executable digest pinned in the manifest;
  no PATH/Homebrew discovery or upstream fallback. Fetch through the platform runtime
  artifact channel. License notices accompany the managed installation; see [README](README.md).
- Patched Baguette builds use a distinct `-lody.N` runtime version/cache/key. Keep
  the patch and source/toolchain provenance with the archive; never relabel patched
  bytes as an upstream release. Packaging: `scripts/package-baguette-runtime.mjs`.
- Local controls use trusted Machine RPC without Cloud I/O. Remote commands require
  exact signed preview-control proofs, including list/status and the ephemeral response
  key. Never put a viewer URL in workspace-readable Streams. Revocation fences proof
  verification as well as startup; owner/machine reassignment closes existing viewers.
  Browser and Simulator have independent service/proxy owners and share only transport
  primitives. There is no simulator sharing route or anonymous viewer grant.
- Agent starts reserve/prepare but defer capture and transport selection to the first
  authorized panel start/status. Agent reads never attach or renew; cancellation and
  idle expiry must settle that wait and release its lease. Agent ingress derives the
  active invocation user in the daemon; never accept an agent-supplied requester.
