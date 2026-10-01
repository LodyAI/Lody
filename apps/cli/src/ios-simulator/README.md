# Simulator preview implementation

`service.ts` owns ephemeral operations, `control-leases.ts` excludes competing
sessions across workspaces, and `devices.ts` is the simctl boundary. Lifecycle RPC
uses the shared `iosSimulator: 1` capability and `ios-simulator/control` command
union. Browser owns a separate service and separate transport instances.

An operation shares its native process and control gateway across local and remote
viewers of the same authorized session. Endpoints are created lazily per transport;
status/start returns only the caller's endpoint, never another device's loopback URL.
The gateway has separate local/remote paths so each stream retains its own flow
budget while controls and portrait initialization remain operation-owned. Tunnel
failure does not interrupt local viewing; explicit start retries that endpoint.
Stop ends both endpoints. Remote revocation conservatively ends any operation with
a remote attachment, including its local endpoint. Device shutdown is never implied.

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
unverified. Multitouch, physical-key forwarding and advanced device configuration are later work.

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

The fixed viewer prefers Baguette AVCC/H.264 when WebCodecs is available. It probes
support for the actual avcC configuration; unsupported configurations and decode/protocol failures
reconnect once using MJPEG. Transport interruption retries H.264 with a bounded budget. Existing private capability, operation,
origin and touch-release boundaries apply. No runtime rebuild/mirror or new dependency
is required. Remote H.264 targets viewport resolution with scale at most 2, starts at
600 kbps, and adapts between 150 kbps and 2 Mbps from sustained ACK queue delay; same-machine
video retains native resolution at 4 Mbps. These are encoder targets, not guarantees.
Tiny static deltas do not count as evidence that a higher bitrate will fit the link.

`h264-codec.ts` parses the pinned encoder's progressive SPS/PPS and slice reference
numbers. A native backlog gap invalidates the chain. `h264-flow.ts` preserves encoded
order, with at most 64 queued packets, 2 MiB, and one second of unsent age; overload
abandons the chain until an IDR. Recovery requests are at most once a second, after
outstanding credit drains. Every IDR carries its avcC. The outstanding window is
bounded by 64 frames and 64–256 KiB remotely (2 MiB locally; an oversized IDR alone).
Bitrate pacing and receiver credit are separate from JPEG's size/RTT estimator.
The browser bounds configuration/decode work and coalesces only decoded VideoFrames;
all discarded GPU frames close. At 16 pending decode requests or 32 pending outputs,
submission waits for dequeue/output rather than resetting the reference chain. The
encoded queue remains bounded to 32 packets / 2 MiB. Overflow or three seconds
without decoded progress requests a fresh IDR; hiding cancels the watchdog.
Three unsuccessful recoveries are allowed before MJPEG. Thirty decoded pictures
spanning at least three seconds, with no output gap over one second, reset that
budget. A lone successful picture or an idle interval does not.
Unexpected reference layouts fail to the known JPEG path rather than guessing.

MJPEG fallback uses viewport/DPR-based integer downsampling (1–4, DPR capped at 2),
then trade sharpness for responsiveness on slow links, aiming for 8 delivered FPS
without promising that rate. Quality recovers no faster than every 10 seconds. The
sending ceiling is 30 FPS; same-machine streams retain native resolution and a
60 FPS ceiling. The native MJPEG encoder still runs on changed surfaces, so this is
not an encoder FPS fix. No new runtime artifact or mirror is required.

The gateway sends sequenced JPEG packets through the existing private proxy. A bounded
receiver-confirmation window (2–8 frame cap, remote byte budget estimated from one
base RTT plus 150 ms, clamped to 8–128 KiB; 2 MiB locally; one oversized frame alone) and a single replaceable pending frame prevent unlimited stale
video from entering the tunnel. JPEG acknowledges a drawn frame; H.264 acknowledges decoded output independently of RAF and retains only one unpainted picture. Visible H.264 painting uses RAF with a 100 ms timer fallback. Recovery explicitly acknowledges discarded work before requesting an IDR. A 10-second receiver stall closes the stream;
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
of the same screen. Static MJPEG screens correctly report zero FPS; H.264 emits small repeated deltas to keep the decoder progressing.

- `codecH264`: 1 for H.264, 0 for MJPEG. `codecFallback`: 0 none/API absent, 1 unsupported configuration, 2 explicit native codec rejection, 3 decode/protocol failure. Transport errors never permanently downgrade the codec.
- `codecFailure`: detail for fallback 3: 1 invalid packet, 2 invalid dimensions, 3 configuration/decode exception, 4 exhausted recovery budget.
- `videoRecoveries` is total recovery attempts; `videoRecoveryStreak` is the current failure budget. `videoRecoveryReason`: 1 encoded queue overflow, 2 no decoded progress, 3 unmatched decoder output, 4 decoder error.
- `videoBackpressure` counts submission pauses; `encodedQueue/encodedQueueBytes` expose bounded browser buffering. These are numeric diagnostics, never input contents or exception text.
- `encoderBitrate`, `keyframeRequests`, `upstreamGaps`, `queuedFrames/queuedBytes` describe H.264 encoder control and pending reference chains. `decoderQueue` counts submitted pictures awaiting output.
- `sourceFps/sourceMbps`: encoded pictures offered to the gateway, including idle stills, not
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
- `ackMs`: gateway send to browser H.264 decode / JPEG draw and returning confirmation, **not one-way latency**.
  `ackIdleMs` is time since that ACK; an idle screen retains the last ACK value.
- `oldestFrameMs/inFlightBytes/inFlightFrames`: outstanding receiver work;
  `droppedFrames/viewerDroppedFrames`: cumulative intentional freshness drops.
- `decodeMs/decodeP95Ms`: JPEG decode plus canvas draw, or H.264 submission to decoder output, excluding RAF wait and network;
  `gatewaySampleAgeMs` and report `ageMs` identify stale observations.
- `scale`: requested native integer downsampling; `width/height`: actually decoded pixels.
  A static screen changes dimensions on its next changed frame.

In browser DevTools, select the simulator iframe and run `lodySimulator.stats()` or
`lodySimulator.history()`. `lodySimulator.setLogging(true)` opts into console samples;
`false` disables it. The daemon writes `[iOS Simulator media]` numeric summaries every
30 seconds. No per-frame logs, automatic upload, URLs, input text or pixels. Existing
cloudflared connection logs identify QUIC/HTTP2; the viewer does not guess that protocol.

H.264 transport recovery retries twice per iframe (500/1500 ms), then leaves Restore
visible. An eight-second absence of all socket messages also triggers recovery;
receiving gateway statistics alone does not prove that video is progressing. Hide
cancels pending retries. Every new socket revalidates the existing private capability.

Additional numeric diagnostics: `transportRetries`; `transportFailure` (1 close,
2 socket error, 3 no messages for eight seconds, 4 first-frame timeout);
`transportCloseCode` (0 if unavailable); `messageIdleMs`, `frameIdleMs`,
`decodeIdleMs`, `paintIdleMs` (0 before the first corresponding event);
`lastReceivedSequence`, `lastAckSequence` (H.264, reset per connection),
and `paintPending` (0/1). These distinguish network silence from decode/paint
starvation. H.264 ACK delay now excludes RAF waiting, while JPEG still includes draw.

H.264 bitrate decisions use complete two-second feedback windows with at least
eight ACKs. At least 75% must exceed minimum RTT + 350 ms before reducing the
bitrate; a slow outlier is insufficient. Recovery requires at most 10% slow ACKs,
a near-baseline minimum, actual payload demand, and five seconds since the last
change. A two-second ACK gap resets the observation. The independent frame/byte/age
limits still apply during sparse feedback or a stall. `feedbackSamples`,
`slowAckPercent` and `feedbackMinAckMs` describe the last completed window.

`rafPaints` and `timerPaints` are cumulative H.264 draw counts, `paintScheduleMs`
is average scheduling-to-draw delay per browser sample, and `receiveGapMaxMs` is
the largest inter-frame arrival gap in that sample. Coalesced decoded pictures
are intentional freshness drops; a low draw rate alone does not establish slow
decoding or RAF suspension. Gateway and browser counters use different sample
times; consult `gatewaySampleAgeMs` before comparing sequences or FPS.


### Input feedback latency

Touch down/up are sent immediately on the established media WebSocket; only move
events coalesce to one animation frame. Remote H.264 may replace an unsent chain
older than 100 ms at a touch edge, but only when a replacement IDR can be requested
immediately. The one-second request cooldown, pacing, byte/frame credit and oldest
in-flight age all remain enforced. A quick release during cooldown preserves the
replacement chain. Corrupted chains still reset unconditionally. Recovery can
pipeline an IDR behind acknowledged-or-in-flight pictures instead of waiting for
all ACKs to drain; ordered delivery and cumulative credit remain unchanged.

- `inputAckMs`: last touch edge sent → gateway validates and forwards it to native
  → receipt reaches this viewer. Includes both network directions and socket
  buffering; **does not measure guest execution or visible feedback**.
- `inputAckSamples` / `inputAckP95Ms`: receipt count and P95 in the current 2-second
  sample (zero samples means no measurement). Move events do not request receipts.
- `queueWaitMs`: most recently sent H.264 frame's time in the gateway's unsent queue.
- `queuedAgeMs`: current oldest unsent H.264 frame age; zero when empty.
- `interactionResets`: cumulative elective pre-input queue resets for this stream.

Input receipt IDs and timestamps remain private, numeric and bounded (32 pending
receipts, 120 samples); disconnect clears them. An echo can be skipped under socket
backpressure. These timings need no clock synchronization. High input RTT with low
queue wait points toward transport/scheduling; low input RTT does not establish that
the guest rendered promptly. Network propagation and already-sent bytes cannot be
removed by dropping an unsent queue.
