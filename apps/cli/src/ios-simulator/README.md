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
React iframe validates source/origin/operation before accepting viewer state.
Opaque (`file://`) desktop parents transfer a MessagePort to the exact viewer origin;
the artifact binds it once after validating the parent and operation, and uses it for
state, visibility, controls, artwork and screenshots. Navigation disposes the channel.
There is no wildcard-origin reply. Web parents retain their exact-origin handshake;
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

## Media delivery and recovery

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

H.264 transport recovery retries twice per iframe (500/1500 ms), then leaves Restore
visible. An eight-second absence of all socket messages also triggers recovery;
receiving a timing probe alone does not prove that video is progressing. Hide
cancels pending retries. Every new socket revalidates the existing private capability.

H.264 bitrate decisions use complete two-second feedback windows with at least
eight ACKs. At least 75% must exceed minimum RTT + 350 ms before reducing the
bitrate; a slow outlier is insufficient. Recovery requires at most 10% slow ACKs,
a near-baseline minimum, actual payload demand, and five seconds since the last
change. A two-second ACK gap resets the observation. The independent frame/byte/age
limits still apply during sparse feedback or a stall.

### Input feedback latency

Touch down/up are sent immediately on the established media WebSocket; only move
events coalesce to one animation frame. Remote H.264 may replace an unsent chain
older than 100 ms at a touch edge, but only when a replacement IDR can be requested
immediately. The one-second request cooldown, pacing, byte/frame credit and oldest
in-flight age all remain enforced. A quick release during cooldown preserves the
replacement chain. Corrupted chains still reset unconditionally. Recovery can
pipeline an IDR behind acknowledged-or-in-flight pictures instead of waiting for
all ACKs to drain; ordered delivery and cumulative credit remain unchanged.

Home, App Switcher and Lock use a preview-owned guest virtual button service. Xcode
27 Device Hub can suppress Baguette's legacy hardware-button service while its
requests still acknowledge success. The new service coexists with Device Hub and
never resets its notify state or restarts SpringBoard. Fixed bundled Objective-C
source is compiled with the installed simulator SDK into a private temporary
directory (Apple Silicon, iOS 17+ target); no downloaded compiler or PATH helper is
used. iPhone/iPad preview preparation warms it; preparation failure leaves video
available and subsequent button requests report failure. The first compile is paid
at preparation; warm commands reuse the process. Acknowledgements mean both HID
edges were accepted, not that the guest app completed an animation. EOF releases
an in-progress key, closes the service, and cleanup joins the child before deleting
the temporary directory. Unknown replies/timeouts fail without replaying a press.
