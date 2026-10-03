# WebRTC transport for simulator previews

Status: implemented
Translation: current

[中文](2026-10-03-ios-simulator-webrtc.zh.md)

## Abstract

Remote simulator frames previously shared the Quick Tunnel WebSocket path with page loading. The viewer now prefers WebRTC DataChannels for media and input, retaining the existing codecs and lease checks. An optional cloud capability supplies short-lived TURN credentials; local viewers remain offline. Quick Tunnel is still needed to load the viewer and exchange signaling, so this does not recover a failed initial tunnel. Real provider relay and constrained-network acceptance remain unverified.

## Decision and trade-offs

Keep the fixed viewer and H.264/MJPEG flow-control protocol instead of introducing a native RTP encoder. Two ordered reliable channels preserve encoded reference chains and isolate control messages from media chunking. The CLI bridges the same bound-device stream boundary, avoiding a second authority/input implementation. Reliable delivery can still stall under packet loss; decoded ACK credit and bounded queues remain necessary.

Use werift rather than a native WebRTC addon so CLI packaging stays JavaScript-based. Its DTLS certificate dependencies require a shared ASN.1 schema registry; the workspace pins the registry consumed by x509 accordingly. The pinned werift patch cancels pending TURN handshakes/allocations, joins ICE gathering and stops allocation-refresh timers before closing. The CLI selects the provider's TLS/443 relay first because this werift version uses only one TURN URL. A binary-data dependency patch makes its internal imports relative so the bundled CLI resolves them without node_modules. The viewer signals once a relay candidate exists rather than waiting for unrelated UDP gathering. Short-lived ICE credentials enter through the optional platform cloud port. They stay operation-local and never enter synchronized documents. Local-only composition has no authenticated cloud provider.

The [original panel decision](2026-09-27-ios-simulator-panel.md) remains the source for device ownership and private preview boundaries. This change replaces only its remote transport choice. The [preview Spec](../../../../specs/ios-simulator-preview.md) remains draft.

## Evidence and limits

Cancellation regressions stop real stalled TLS handshakes and TCP TURN allocations after explicit socket events. A real local werift pair exchanges chunked frames and input over DTLS/SCTP and closes on abort. Viewer behavior tests exercise reassembly, startup fallback and uncertain-control rejection. Gateway regression covers teardown with an incomplete signaling body. Existing simulator tests and CLI typecheck pass. Provider authorization and response tests use synthetic credentials; no paid TURN service was configured or deployed, and no remote latency improvement is claimed. An established relay may fail when credentials expire; the viewer then uses its WebSocket recovery path instead of refreshing that peer in place.

## Preview connection details

The popover uses simple preview wording and omits the transport-mode icon and explanation row. Transport details remain available in error diagnostics. “Direct” was rejected as a remote transport label because WebRTC can use TURN. Only active errors expose diagnostics copying; successful fallback is a normal compatibility state. The authenticated viewer state carries optional allowlisted transport, codec and fallback stage, accepted through the existing source/origin/operation boundary. Older viewers report unknown transport instead of guessing. Reports also include client network, visibility and browser capabilities; no SDP, candidate addresses or credentials are copied. Component and CLI typechecks cover integration; tests and live cross-device acceptance were not run for this UI follow-up.

## Ablation-guided simplification

Removed the unused peer UUID, repeated cancellation checks already enforced by the common failure handler or the synchronous send loop. Overlapping device controls now close the peer instead of maintaining a special busy-response branch; the viewer normally permits only one pending control. No command is replayed.

Baseline: 10 RTC tests passed. Server and viewer deletions passed independently. Removing the opened flag passed tests but review found it lost the last transport in failure diagnostics; that deletion was reverted. Removing frame-offset validation as a negative control made the discontinuous-frame regression fail, so that guard remains. The final 11 tests include real DTLS/SCTP delivery, abort, overlapping-control closure and pending TCP/TLS TURN cleanup. Keep normal network fallback, authorization, bounded buffers and teardown: these protect exercised behavior. These local experiments do not establish live TURN or cross-network reliability.

## Standalone CI integration

CI checks the merge with main, whose Codex ACP submodule requires SDK ~1.5.0, ajv and Vitest 5. Refresh the public lockfile against those pinned manifests, in a standalone clone. An embedded private install uses a different lockfile and cannot verify this boundary. Keep the seven-day dependency quarantine; explicitly allow the already selected werift ASN.1/mediabunny versions and main's Codex runtime. pnpm 10.20 uses the first matching package rule, so multiple exact Codex releases and platform variants must share one exact-version union. Verify platform optional packages remain in the lockfile and validate a frozen standalone install.

CLI packaging capacity: WebRTC pushed the monolithic entry sourcemap over the 2 GiB build budget (removing RTC in a temporary ablation restored the build). Keep npm packages in separate vendor chunks and CommonJS helpers in a dedicated chunk, with Rollup transitive assignment to avoid helper cycles through the entry. Preserve sourcemaps and flat worker filenames. Dynamic RTC loading, source-content exclusion and individual dependency splits did not resolve the limit; a single all-vendor chunk was rejected because it couples worker loading. Validate the real bundle, not just compilation.
