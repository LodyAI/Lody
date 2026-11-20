# Simulator preview implementation

`service.ts` adapts the legacy iOS wire contract to the shared
[device preview core](../device-preview/README.md), which owns ephemeral operations
and machine-wide platform-scoped leases. `devices.ts` is the simctl boundary. Lifecycle RPC
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

The pinned Baguette executable runs in an IPC-owned worker. Worker, native server,
simctl and guest-helper processes start through `@lody/shared/node/process`;
cancellation joins the shared whole-tree termination policy. The native HTTP API
stays on loopback; only the bound device's MJPEG stream and validated one/two-finger
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
stay out of workspace RPC. Device controls advertise `iosSimulatorControls: 2` independently
of lifecycle protocol compatibility. Version 1 covers the original device controls. Version 2
adds a software keyboard toggle for focused text fields on iPhone and iPad. The reply
acknowledges the command without reporting keyboard visibility.

## Two-finger input

Touchscreens send paired coordinates for pinch, rotation and pan. The second
finger ends the single-touch gesture before starting a native touch2 gesture.
Either finger lifting ends the pair; the remaining finger must lift before a new
gesture starts. Extra pointers are ignored. Moves coalesce per animation frame;
down/up remain immediate. Cancellation and gateway shutdown release the pair.
Mouse/wheel input remains single-touch; desktop modifier gestures are not added.

## Remote WebRTC transport

The remote fixed viewer attempts two ordered reliable DataChannels: binary media
and JSON controls/status. H.264/WebCodecs and MJPEG remain the codecs; this is not
an RTP video track. The CLI uses werift and loops into the existing device-bound
WebSocket boundary, preserving codec credit, validation and lease renewal. Frames
are split into bounded 16 KiB messages and reassembled before decoding. Each gateway
admits at most four active/negotiating peers and joins them on operation teardown.

Quick Tunnel still carries page bootstrap, artwork and offer/answer exchange. An
optional cloud port obtains short-lived ICE credentials after machine/requester
access verification. Public local-only composition does not install that provider;
local viewers use WebSocket directly. Credentials are cached only in the operation.
Bootstrap failure falls back once to WebSocket; an established connection failure
uses the existing decoder retry path without replaying input. This does not solve
an unavailable initial tunnel, and real constrained-network acceptance remains required.

## Runtime artifact

The [manifest](baguette-manifest.json) pins the official Apple Silicon release
archive, its executable and the upstream commit. The distribution mirror reads
`source` and copies the verified tarball unchanged. Publish the versioned object
and verify its readback before shipping a CLI that references it. To verify a
candidate without uploading, run the distribution mirror with
`--runtime baguette --skip-upload` against the candidate manifest.

The CLI downloads only from the configured runtime channel at
`/api/runtimes/baguette/<version>/darwin-arm64/<fileName>`. It verifies archive
size and SHA-256, checks the extracted executable digest, writes
[third-party notices](baguette-notices.json), and reuses the verified versioned
cache offline. Preview requires Apple Silicon, macOS 15+, Xcode and an installed
iOS Simulator runtime.

For upgrades, compare the release checksum and tag revision, hash the extracted
executable, and refresh notices against the tagged license and dependency lock.
Exercise the final binary and adjacent resource bundle through the CLI worker on
a booted simulator. Keep a stream open for three native WebSocket pings, close
normally, reconnect and verify that stopping the worker reaps the server. These
checks cover the [historical WebSocket sleep crash](../../../../.agents/notes/implemented/bug-fix/2026-09-29-baguette-runtime-sleep.md).

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
