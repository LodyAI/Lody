# Native Simulator transport

`SimulatorStreamView` owns the shared floating/full-screen renderer, decoder,
heartbeat and bounded codec retries. `SimulatorTransport` prefers a native
`SimulatorRTC` peer, then switches once to `URLSessionWebSocketTask`. Older gateways
returning 404 for `rtc-config` follow that same fallback. An intentional close or
background suspension cancels signaling, the peer, pending controls and the socket;
late callbacks cannot reopen them.

The wire contract follows LodyAI/Lody `e135cdb5` (PR #1227): authenticated relative
`rtc-config` and `rtc` endpoints, a complete SDP offer/answer, ordered reliable
`media` and `control` channels, `rtc-ready`, and correlated `rtc-control-result`
replies. Media uses 16 KiB chunks with uint32 big-endian total length and offset.
The original H.264/MJPEG decoder, ACK credit, viewport and touch envelopes are
unchanged. This is data-channel transport, not RTP video.

ICE credentials stay in the operation's native peer and ephemeral HTTP session.
Requests retain the viewer capability and Origin, reject redirects and bound
signaling responses. No cloud credential is fetched by the iOS viewer itself.
Quick Tunnel is still required for signaling, artwork and WebSocket fallback.
WebRTC may use TURN, so it does not imply a direct route.
The localized local-network permission explains connections to the user's Mac;
declining it can still leave TURN or WebSocket available. No Bonjour browsing,
camera or microphone permission is needed by this transport.

On fallback, partial frames and active touches are discarded, decoder state is
reset and stream configuration is sent afresh. A hardware action whose reply was
lost is rejected locally, never retried over HTTP. There is no input queue across
connections. Codec rejection (4002) retains the existing MJPEG recovery path.

The peer is libdatachannel, built by `packages/LodyKit/DataChannel/build.sh` from pinned commits
into `packages/LodyKit/Vendor/LodyDataChannel.xcframework` during `pnpm prebuild` (needs `cmake`); notices ship in Settings. Its ICE agent,
libjuice, relays through TURN over UDP only: `turn:?transport=tcp` and `turns:`
servers are skipped, and a UDP-blocked network falls back to WebSocket.
Run `pnpm verify:native --case simulator-transport` for native transport behavior
and `pnpm verify:ui --app <app> --case simulator-preview` for both preview hosts.
These offline checks do not prove real TURN service availability or WAN performance.

Interactive dismissal uses UIKit's zoom transition. `LodyWillPush` configures
it before UIKit starts the push; native preferred transitions own their interaction gestures. Swipes inside the remote
device remain remote input.

Development builds also carry the upstream `expo-dev-menu` gesture fix from
[PR #43338](https://github.com/expo/expo/pull/43338) for
[issue #43253](https://github.com/expo/expo/issues/43253): window/scene notifications
replace the window getter interception, and unrelated touch sequences fail early.
Keep the held/cancelled/committed `simulator-preview` checks when updating or
removing these patches; checking only the final route misses the regression.
