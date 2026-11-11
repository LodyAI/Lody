# Encrypted-workspace RPC over iroh

Status: proposed
Translation: current
Date: 2026-11-10

[中文](2026-11-10-e2ee-iroh-transport.zh.md)

## Abstract

Encrypted workspaces send realtime RPC frames over Streams, which depends on the
backend and adds a hop. The owner made iroh the preferred route on 2026-11-10:
the desktop main process and the CLI open one iroh endpoint per workspace ledger
device key, and carry the same signed frames on ALPN `lody/e2ee-rpc/1`, while
Streams RPC and durable dispatch remain as fallbacks. Reachability needs no
control plane: a dialer addresses the target with every Lody relay, so no address
is published and Convex is unchanged. Latency, hole-punching rate, Windows firewall
behavior and packaged-platform loading are not yet measured.

## Problem

The [foundations Spec](../../../../specs/e2ee-foundations.md#preferred-route-iroh)
deferred iroh from the MVP on 2026-10-28 but kept its identity decision: EndpointId
is the workspace ledger device's Ed25519 public key. Encrypted Streams RPC needs a
backend round trip on every request, and the owner wants to retire it from
encrypted workspaces once all platforms can use a device-to-device route.

## Decision

- **Transport only.** Iroh carries the existing request (purpose 8) and response
  (purpose 9) frames in the same `{id, frame}` JSON envelope that Streams uses.
  Receivers pass them to the existing receiver, journal, authorization and
  actual-start claim. Transport authentication of the dialer is never authority.
- **Wire format.** One bidirectional QUIC stream per request on ALPN
  `lody/e2ee-rpc/1`. The dialer writes one big-endian `u32` length-prefixed message
  and finishes; the listener writes zero or more replies and finishes. Messages
  above 2 MiB + 4 KiB are refused. A listener queues at most 128 unclaimed requests
  and resets streams beyond that, and allows 32 concurrent streams per peer.
- **Route order.** iroh → encrypted Streams RPC → durable dispatch. With a live
  connection to the target, the request goes over iroh only. Without one, the
  request goes over Streams RPC while the connection is prepared in the background.
  An iroh failure retries the same original over Streams; the shared claim
  deduplicates arrivals on both routes.
- **Identity and key custody.** Custody holds the device seed only transiently while
  importing it as a non-extractable WebCrypto key, and iroh has no external-signer
  hook. Node custody therefore gains one purpose-limited operation that decrypts
  the seed and hands it to the native opener. The native layer wipes the JavaScript
  buffer immediately and its own copy when the endpoint closes; it exposes no
  signing or export API and never crosses IPC. The seed signs only TLS 1.3 and iroh
  relay handshakes (`iroh-relay handshake v1` domain-separated); Pkarr records are
  not used. A process-wide registry allows one live endpoint per device key.
- **Reachability.** Every dial adds all configured relay URLs to the target's
  `EndpointAddr`; iroh sends QUIC Initial packets to all known paths, so the packet
  reaches the peer on whichever relay it chose as home. No DNS, Pkarr or Convex
  address lookup is configured. The target is Lody-run `iroh-relay` servers with
  shared-token access control (deployment package in the private repository).
- **Interim relays.** On 2026-11-10 the owner chose n0's four public relays
  (`use1-1`, `usw1-1`, `euc1-1`, `aps1-1` under `relay.n0.iroh.link`, as listed in
  `iroh/src/defaults.rs` at v1.4.1; no token) until Lody relays are deployed. The
  switch is configuration only (`VITE_IROH_RELAYS`). Accepted costs: n0 can observe
  device public keys, IP addresses and who communicates with whom (content stays
  end-to-end encrypted); public relays are rate limited with no availability
  guarantee; and n0 retires public relays per release line, as it announced for
  0.35 on 2026-12-31.
- **Capability boundary.** Relay URLs and the token come only from the official
  build composition. The local-only desktop and hosts without the native module
  have no iroh capability and keep the existing routes.
- **Lifetimes.** The machine-side endpoint is a separate fiber beside the Streams
  listener started by `startRpc` in `apps/cli/src/lib/e2ee/workspace-legacy.ts`, so
  either can fail and restart (iroh every 30 seconds) without the other; `stopRpc`
  interrupts both and the endpoint closes in its finalizer. The desktop endpoint
  opens on first use inside the workspace entry in
  `apps/electron/src/main/services/e2ee-runtime.mts` and closes with it, so it
  follows the reader leases without a separate idle timer.
- **Scope of the first version.** Dispatch and single-frame feature requests use
  iroh. Chunked feature requests stay on Streams, whose receiver reassembles chunks
  across envelopes; carrying them on one QUIC stream needs a receiver change.
- **Loading.** The JavaScript loader takes an explicit file. The cloud desktop build
  ships `lody-iroh.<platform>-<arch>.node` in its resources directory; main loads it
  there and passes `LODY_IROH_NATIVE_PATH` and the relay settings to the embedded
  CLI. The public desktop and the standalone npm CLI ship no module.
- **Native code.** `packages/iroh-native` holds the platform-neutral `lody-iroh`
  crate and a napi-rs binding. Mobile uses a UniFFI binding of the same crate
  (`uniffi/`), dial-only with port mapping disabled.
- **Mobile seed handoff.** The mobile app runs the portable host in its WebView, which
  already holds the device seed. `BrowserDevice.withTransportSeed` passes a copy once
  per session to one native plugin (open, status, send, receive), which never returns
  it. Capacitor serializes the argument, so one unwipeable JavaScript string of the
  seed lives until garbage collection; the owner accepted that cost (2026-11-10).

## Evidence

Inspected iroh source at v1.4.1:

- `iroh/src/socket/transports/relay/actor.rs` (`active_relay_handle_for_endpoint`):
  a dialer opens a connection to any relay URL named in the target address.
- `iroh/src/socket/remote_map/remote_state.rs`: Initial packets go to all known
  paths when no path is selected.
- `iroh-relay/src/protos/handshake.rs`: relay authentication signs a BLAKE3-derived
  challenge or 16 bytes of TLS exported keying material, both domain-separated.
- `iroh/src/tls.rs`: 1.x TLS uses RFC 7250 raw public keys.
- `iroh-base/src/key.rs`: `SecretKey::from_bytes(&[u8; 32])`.

External facts:

- [iroh #3813](https://github.com/n0-computer/iroh/issues/3813) shows relay eviction
  when two endpoints share a key.
- [GHSA-7cq4-mhxw-xw78](https://github.com/n0-computer/iroh/security/advisories/GHSA-7cq4-mhxw-xw78)
  (fixed in 1.1.0) sets the 1.4.1 floor.
- [fedimint #9378](https://github.com/fedimint/fedimint/issues/9378) records the iOS
  Local Network prompt caused by port mapping.
- n0 documents that public relays are rate limited and not recommended for
  production.

## Alternatives

- **Tailcat** (Tailscale, 2026): WireGuard Curve25519 identity cannot reuse the
  ledger Ed25519 key, so it would need the rejected separate network key. It is
  also an experimental Go library with no stability guarantee.
- **Publishing addresses in Convex.** This would add backend state and coupling for
  no benefit once multi-relay dialing reaches every peer.
- **n0 DNS/Pkarr address lookup.** This would add a third signed protocol for the
  device key and a third-party dependency.
- **Official iroh-ffi mobile bindings.** Their default features enable port mapping
  (iOS Local Network prompt) and `fast-apple-datapath` (private Apple APIs), with
  no switch exposed.
- **Browser iroh.** It is relay-only and has no official package, so it is out of
  scope by owner decision.
- **iroh compiled to WebAssembly inside the mobile WebView.** A spike (iroh 1.4.1,
  `tls-ring`, 0.97 MB gzip) completed relay-only round trips in WebKit (355 ms) and
  Chromium (319 ms) and kept the seed out of any bridge, but stays relay-only with no
  direct paths. The owner chose the native plugin for direct connectivity.

## Consequences

- A dialer keeps a connection to every configured relay. A relay outage affects
  only the devices homed on it until they move to another relay.
- The shared relay token can only be rotated by redeploying. Abuse would move
  relays to callback authorization.
- Streams RPC removal from encrypted workspaces needs a later Spec revision after
  every supported platform has migrated and compatibility is verified.

## Verification

- `packages/iroh-native/core/src/tests.rs` covers multi-reply calls, connection
  reuse, dialing a peer homed on a relay the dialer names among others, the one-key
  rule, oversized requests, unreachable peers and rejected streams.
- `packages/iroh-native/test/endpoint.test.ts` covers the binding: seed wiping, the
  one-key rule, invalid seeds and close.
- `apps/cli/src/lib/e2ee/realtime-rpc.test.ts` serves one signed original through a
  real iroh listener and the real receiver, verifies the ACK, then delivers the same
  original over Streams and observes a single offer.
- `apps/cli/tests/e2ee-runtime.test.ts` opens an endpoint through CLI custody and
  checks that the EndpointId is the ledger device key and the seed is wiped.
- `packages/components/tests/encrypted-dispatch-legacy.test.ts` covers route
  selection: iroh with a live connection, Streams with the same original after no
  connection, a failed call or no verifiable reply, and chunked originals.
- Exploratory local acceptance on 2026-11-10 (macOS arm64, local stack over HTTPS/h2,
  cloud desktop test-build, embedded CLI, n0 public relays, head `39e57c00`): three
  messages in one encrypted session each executed once and each had a matching CLI
  `[e2ee-iroh] request` and renderer `iroh-reply`; an agent edit produced a real
  diff and file preview; capability refresh (a feature request) answered over iroh;
  without the module the CLI fell back to Streams and executed once. Not a clean
  scripted run, and diff/preview content was not shown to travel over iroh.
- That run found two defects fixed in this PR: Cargo's macOS strip step produced a
  dylib Node and Electron refused ("mis-aligned LINKEDIT string pool"), and on a
  network that reaches the internet only through an HTTP proxy the endpoint never
  connected to a relay until it used the proxy (direct: `iroh_connect_timeout`;
  via `127.0.0.1:1087`: both endpoints online, reply in about 937 ms).
- Not yet verified: the desktop client against a deployed relay; send-to-actual-start
  latency over direct, relay-only and Streams routes; hole-punching rate; Windows
  firewall prompts on the listening machine; native module loading and macOS signing
  in packaged installers on every platform.
