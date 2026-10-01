# Simulator preview implementation

`service.ts` owns ephemeral operations, `control-leases.ts` excludes competing
sessions across workspaces, and `devices.ts` is the simctl boundary. Lifecycle RPC
uses the shared `iosSimulator: 1` capability and `ios-simulator/control` command
union. Browser owns a separate service and separate transport instances.

The pinned Baguette executable runs in an IPC-owned worker. The native HTTP API
stays on loopback; only the bound device's MJPEG stream and validated single-pointer
input cross `gateway.ts`, along with typed device controls on the private preview
connection. `device-controls.ts` maps these controls to fixed native endpoints;
text writes the simulator clipboard through the IPC worker, then sends Cmd-V.
`host-controls.ts` owns fixed xcrun commands for pasteboard, appearance, shake and deep links,
joining their exit on cancellation. Baguette handles HID only; its Foundation subprocess
paths are not used because killing the server does not reap their separate process groups. The gateway serves the fixed `viewer.ts` artifact. The
React iframe validates source/origin/operation before accepting viewer state;
live frames never enter React, RPC, or synchronized documents. An explicitly requested
screenshot transfers one bounded PNG to the parent for saving or staging as a composer
attachment; capture never sends a message automatically. Input text and deep links also
stay out of workspace RPC. Device controls advertise `iosSimulatorControls: 1` independently
of lifecycle protocol compatibility.

## Runtime artifact

`baguette-manifest.json` pins the Lody-patched archive and executable digests. The
installer fetches only the platform runtime channel:

```
/api/runtimes/baguette/0.2.1-lody.1/darwin-arm64/baguette_v0.2.1-lody.1_macOS_arm64.tar.gz
```

The deployment composition must publish these exact bytes before shipping. The
private distribution repository provides `mirror-agent-runtimes.mjs --runtime
baguette` (use `--dry-run` to inspect the plan). There is no upstream, Homebrew or
PATH fallback. Reuse the verified versioned cache; downloads need connectivity,
while a cached same-machine preview does not require Cloud authorization.

`baguette-notices.json` contains Baguette's Apache-2.0 license and licenses/notices from
the exact dependency revisions in v0.2.1's `Package.resolved`; source URLs accompany
each notice. The installer writes them as `THIRD_PARTY_NOTICES.txt`. Version changes
must refresh both digests and notices, then rerun native compatibility checks.

Supported native artifact: Apple Silicon, macOS 15+, Xcode and an installed iOS
runtime. Intel has no pinned artifact. Local smoke evidence used Xcode 26.6 / iOS
26.5 and verified device enumeration, managed installation, real JPEG delivery and
preview cleanup. Full Electron sidebar, remote Quick Tunnel and mobile E2E remain
unverified. H.264, multitouch, physical-key forwarding and advanced device configuration are later work.

## Maintaining the patched build

The upstream v0.2.0 and v0.2.1 Release binaries crash at the first 30-second
WebSocket ping. A symbolized source build reproduces this at `Task.sleep(for:)`;
replacing all three sleeps in `swift-websocket`'s `WebSocketHandler` also prevents the same
crash during connection shutdown. See the [decision](../../../../.agents/notes/implemented/bug-fix/2026-09-29-baguette-runtime-sleep.md).

Upstream v0.2.1 fixes the separate `baguette stream` startup crash
([PR #88](https://github.com/tddworks/baguette/pull/88)); Lody uses `baguette serve`.
Its dependency lock and license are unchanged from v0.2.0. The official v0.2.1
arm64 archive reproduced the sleep abort after 31.4 seconds, so `0.2.1-lody.1`
retains the same three-call patch. Recheck both ping and close paths before
removing it on a later upgrade. The patched build and public-channel download each
survived three real pings (~91 seconds) on Xcode 26.6/iOS 26.2; the download also
completed a normal WebSocket close before clean process shutdown. This is bounded
compatibility evidence, not a long soak or full application E2E.

`baguette-manifest.json.build` records the exact source revision, dependency
revision, patch digest, Swift version and build command. To rebuild, clone the
upstream repository at that revision, resolve the checked-in `Package.resolved`
with `swift package resolve --force-resolved-versions`, and check the
`swift-websocket` checkout revision. Apply
`patches/swift-websocket-continuous-clock.patch` in that checkout (SwiftPM marks
it read-only; grant owner write access to `Sources/WSCore/WebSocketHandler.swift`
first). Run the recorded build command. Keep the executable and adjacent
`Baguette_Baguette.bundle` together.

From this repository root, package the already verified build:

```sh
node scripts/package-baguette-runtime.mjs --build-dir <swift-release-directory> --output-dir <artifact-directory>
```

The packager verifies the pinned executable and patch, includes resources,
notices, the patch and `BUILD_PROVENANCE.json`, and compares two normalized gzip
archives. It excludes debug-symbol bundles. `--print-pins` writes the candidate
archive and prints its hash/size without changing the manifest or publishing.
A new native build requires a reviewed executable pin and a fresh `-lody.N`
version if any published bytes differ. Archive packaging is deterministic;
Swift compilation across paths/toolchains is not promised byte-reproducible.
Never overwrite an existing immutable version to accept a rebuild.

The initial publication supplies the local archive to the distribution mirror
with `--runtime baguette --baguette-artifact <archive>`. Later mirror runs can
retrieve the same pinned bytes from the manifest's public channel URL. Publish
and verify the new object before shipping the updated CLI manifest.

## Verification

Run the simulator tests plus the existing local-proxy and Quick Tunnel regressions.
`baguette-process.test.ts` checks real worker/native-child reaping with an isolated
fixture; lifecycle and gateway tests cover cancellation, cross-workspace exclusion,
stale stops, idle expiry, denied media access, input filtering and touch release.
The frontend controller/facade tests cover routing and the exact-origin handshake.

## Media performance diagnostics

Remote streams use viewport/DPR-based integer downsampling (1–4, DPR capped at 2),
then trade sharpness for responsiveness on slow links, aiming for 8 delivered FPS
without promising that rate. Quality recovers no faster than every 10 seconds. The
sending ceiling is 30 FPS; same-machine streams retain native resolution and a
60 FPS ceiling. The native MJPEG encoder still runs on changed surfaces, so this is
not an encoder FPS fix. No new runtime artifact or mirror is required.

The gateway sends sequenced JPEG packets through the existing private proxy. A bounded
receiver-confirmation window (2–8 frame cap, remote byte budget estimated from one
base RTT plus 150 ms, clamped to 8–128 KiB; 2 MiB locally; one oversized frame alone) and a single replaceable pending frame prevent unlimited stale
video from entering the tunnel. Only a drawn frame acknowledges its sequence and any
superseded predecessors. A 10-second receiver stall closes the stream for Restore;
credits and timing probes never count as control activity. Remote sends are also
byte-paced, with no accumulated idle credit. The minimum observed RTT prevents
queue-inflated probes from increasing the budget; an initial probe precedes JPEGs.
Generic proxy behavior is unchanged.

After two seconds without changed frames or input, and once receiver credit drains,
`idle-refresh.ts` captures one viewport/DPR-sized JPEG at quality 0.85 through the
bound device's fixed loopback screenshot route. MJPEG's native `snapshot` is a no-op,
and changing scale alone cannot refresh a static screen. The still is capped at
512 KiB, sent through the same private/ACK path, and never renews the lease. New
frames, input or viewport changes cancel stale work; close aborts and joins the read.
A failed read keeps the last live image and waits for new activity before retrying.
Mobile init keeps the canvas and exterior upright; guest orientation still changes.
Input coordinates and captured pixels follow the chosen display angle consistently.

Open the connection-status popover for resolution, painted FPS, Mbps, RTT, ACK delay
and the in-flight queue. **Copy diagnostics** includes up to two minutes of numeric
samples. Record 10 seconds idle, 20 seconds of continuous scrolling, then 10 seconds
idle, and copy the report while the panel remains open. Compare local and remote runs
of the same screen. Static screens correctly report zero FPS.

- `sourceFps/sourceMbps`: JPEGs offered to the gateway, including idle stills, not
  capture/encoder timing. `idleRefreshFrames` counts sharp stills actually sent.
- `sentFps/sentMbps`: packets the gateway sends; `receivedFps/paintedFps` distinguish
  receipt from drawing. Browser rates use an independent two-second clock, so
  burst-delivered gateway reports cannot create artificial FPS spikes. The server
  and browser intervals are not synchronized; rates are not lifetime averages.
- `rttMs`: a gateway/browser ping round trip over the media connection (zero before
  the first reply); includes transport queues, not a separate network-only probe.
- `baseRttMs`: minimum observed probe RTT for this connection; still an estimate,
  not a guaranteed queue-free network measurement.
- `deliveryMbps`: effective payload-rate estimate from frame completion minus base
  RTT; includes queue/decode/return-path effects, not measured link capacity.
  `pacingMbps` reserves 15% headroom, `windowBytes` is the current credit budget.
- `ackMs`: gateway send to browser draw and returning confirmation, **not one-way latency**.
  `ackIdleMs` is time since that ACK; an idle screen retains the last ACK value.
- `oldestFrameMs/inFlightBytes/inFlightFrames`: outstanding receiver work;
  `droppedFrames/viewerDroppedFrames`: cumulative intentional freshness drops.
- `decodeMs/decodeP95Ms`: JPEG decode plus canvas draw, excluding RAF wait and network;
  `gatewaySampleAgeMs` and report `ageMs` identify stale observations.
- `scale`: requested native integer downsampling; `width/height`: actually decoded pixels.
  A static screen changes dimensions on its next changed frame.

In browser DevTools, select the simulator iframe and run `lodySimulator.stats()` or
`lodySimulator.history()`. `lodySimulator.setLogging(true)` opts into console samples;
`false` disables it. The daemon writes `[iOS Simulator media]` numeric summaries every
30 seconds. No per-frame logs, automatic upload, URLs, input text or pixels. Existing
cloudflared connection logs identify QUIC/HTTP2; the viewer does not guess that protocol.
