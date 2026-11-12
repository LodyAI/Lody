# Native iroh transport

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

These rules bind the CLI machine listener (`apps/cli/src/lib/e2ee/iroh-listener.ts`)
and the desktop client (`apps/electron/src/main/services/e2ee-iroh.mts`) as well as
this package. Intent: [foundations Spec](../../specs/e2ee-foundations.md#preferred-route-iroh);
rationale: [iroh transport decision](../../.agents/notes/implemented/architecture/2026-11-10-e2ee-iroh-transport.md).

- This package moves opaque `{id, frame}` envelopes only. It never parses, verifies
  or authorizes a frame, and it exposes no signing, key export or frame inspection.
  Transport identity of a peer is never authority; receivers keep ledger checks.
- The endpoint secret is the workspace ledger device seed, handed over only through
  a custody `withTransportSeed` (node custody on desktop and CLI). The binding zeroes
  the caller's buffer before returning and wipes its own copy when the endpoint drops.
  Never route the seed through desktop IPC, a renderer or a log; the only WebView
  handoff is the mobile plugin described below.
- A process holds at most one live endpoint per device key; the core registry
  enforces it because two endpoints with one key make relays evict each other.
- Relays come only from the official build composition and every dial names all of
  them. Do not add DNS, Pkarr or control-plane address lookup. n0's public relays are
  the interim configuration until Lody relays exist; never hard-code either set here.
- Absence of the module, relays or a live connection means "use Streams RPC". Never
  let opening, dialing or a failed call delay an available later route, and retry
  only with the same original envelope.
- Listeners admit at most 64 incoming connections including handshakes, and at
  most four established connections per EndpointId. Refuse excess connections
  without spawning waiters. Length headers must not trigger full-body allocation;
  grow buffers only as payload arrives and reject truncated bodies.
- Keep the iroh floor at 1.4.1 or later and follow upstream security advisories.
  Mobile bindings must disable port mapping and `fast-apple-datapath`.
  `Cargo.lock` holds `libc` at 0.2.189: 0.2.190 limits `in6_ifreq` to macOS, which
  breaks `netdev`'s Darwin code on iOS. Raise it only after an iOS build passes.
- `uniffi/` is the mobile binding (dial-only, port mapping always off), built by
  `scripts/build-mobile.mjs`. On mobile the WebView portable host is the trusted
  host: it hands the seed once, through `BrowserDevice.withTransportSeed`, to one
  purpose-limited native plugin that exposes only open, connection status, send and
  receive. Keep that plugin's bridge logging off and never return the seed to JS.
- Rust tests (`cargo test -p lody-iroh`) cover the wire and endpoint rules; Node
  tests load the development build and skip when it is absent, except under
  `LODY_IROH_REQUIRE=1`, where absence fails. CI runs that job on Linux and macOS for
  every main push and for pull requests that change this package, the CLI E2EE code
  that drives it, the lockfile or the CI workflow; extend that path list in
  `.github/workflows/ci.yml` when another caller starts loading the module. Release builds
  are not stripped: Cargo's macOS strip step produced an unloadable dylib.
- Every endpoint keeps UDP segmentation offload (GSO) off. iroh 1.4.1 caches the
  socket's segment limit when it creates the sender, so after a NIC refuses a
  segmented send, open connections keep sending batches that fail
  ([iroh #4555](https://github.com/n0-computer/iroh/issues/4555)); the Android
  emulator returns EIO and stalled every call past the dispatch deadline. Re-enable
  it only on an iroh release that reads the limit per send.

- `connectionPath` reads `Connection::paths()` and reports only the selected
  `direct`, `relay` or `none` path. It never dials, waits for a dial, or exposes
  addresses. Missing host support is an unknown diagnostic, never an RPC failure.
- Personal clients with telemetry accumulate fixed dispatch/feature counters in
  device-local storage under a Web Lock, across workspaces and windows. They
  enqueue at most one `e2ee/iroh_daily` per 24 hours. Target digests remain local;
  local OSS composition and machine CLI do no counting or reporting.
