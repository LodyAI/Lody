# iOS simulator side panel

Status: implemented
Translation: current

[中文](2026-09-27-ios-simulator-panel.zh.md)

## Abstract

Add a dedicated iOS simulator panel to sessions assigned to a macOS machine. Machine RPC lists devices and manages preview preparation, while existing Quick Tunnels carry remote frames. The panel replaces browser navigation and annotation with device selection, connection status, and a small Lody-owned viewer, with Lody-owned device controls and a hardware shell. Browser and simulator require independent endpoint ownership. The first implementation uses MJPEG and a restricted Lody viewer, with no new frontend dependency. A real local service smoke test receives frames and stops cleanly; full remote/mobile acceptance and H.264 remain outside the verified scope.

## Requirements and implemented defaults

Required: gate the entry by the current session's target macOS machine, enumerate all its iOS simulators through RPC, let the user launch a selected device, hide addresses/navigation/annotation, retain status without sharing, minimize dependencies, and allow later custom controls.

Confirmed in this review: direct same-machine connections; no simulator sharing; one controlling Lody session per device. Remote access still uses a background Quick Tunnel, restricted to the authorized controlling session.

Implemented defaults:

- Add `iOS Simulator` next to Browser in the right-panel empty state and `+` menu; do not open it automatically. One simulator panel and selected device per session.
- Use target-machine OS, never viewer OS. Keep the macOS entry while offline with an explanation; do not guess unknown OS. Unsupported protocol shows an upgrade state instead of inferring support from CLI versions.
- Preserve direct same-machine Electron connections and offline viewing; create Quick Tunnels only for remote access, always hiding addresses. No sharing controls, sharing RPC, public links or anonymous viewing mode.
- Browser and simulator may run concurrently. Switching devices releases the old preview and control ownership; the new connection binds only the new device.
- Never automatically shut down a simulator, including one started by Lody. Device shutdown is a later explicit action, separate from stopping preview.

## Complete first-release control inventory

The list header identifies the target machine and its online state. Refresh reads the machine; search and runtime filtering operate on the returned list. Group rows by runtime, with name, model, iOS version, boot state, availability and control occupancy. Short UDIDs disambiguate duplicate names; full IDs belong in details. Include unavailable devices with a reason. Running devices offer Preview; stopped devices offer Start and preview. Listing does not install Baguette, boot devices, or open tunnels.

Preview header: `[Device / iOS version ▾] [Connection status]`, followed by an aspect-fit screen. Device selection reopens the list. Status details contain preparation stage, target machine, closure reason, concise error, retry/restore and stop preview. No address, navigation, webpage refresh, annotation or developer configuration in the permanent toolbar.

| Location       | Control/state                                                                  | Behavior                                                                                                |
| -------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Panel          | Simulator tab and close                                                        | Existing ordering, neighbor selection and local layout persistence                                      |
| List           | Target-machine identity                                                        | Read-only; no machine switching inside this panel                                                       |
| List           | Refresh, search, runtime filter                                                | Explicit machine refresh, local filtering                                                               |
| Device row     | Details, running/unavailable/occupied state                                    | Explain disabled operations                                                                             |
| Device row     | Start and preview / Preview                                                    | One action; no manual port                                                                              |
| Preparing      | Stage progress and Cancel                                                      | Environment, component preparation, boot, connection, first frame; cancel does not mean shutdown        |
| Preview header | Device selector                                                                | Exact UDID switch; reject stale completions                                                             |
| Preview header | Connection status                                                              | Local, connecting, active, expired, failed, machine offline, device stopped                             |
| Status popover | Retry/restore, stop preview, copy diagnostics                                  | No tokens in diagnostics; stop leaves Browser and device alive                                          |
| Screen         | Aspect-fit canvas, tap and single-finger drag                                  | Device-point coordinates; no input while disconnected; release touches on cancel/blur                   |
| Guidance       | Component download, missing Xcode/runtime, denied access, unsupported protocol | Managed pinned component; repair instructions and recheck for Xcode/runtime; no automatic Xcode install |
| Empty/error    | No devices, loading, query failure, first-frame timeout                        | Distinguish empty from failed; appropriate retry/refresh                                                |

The desktop adds a second controls row; mobile places actions in More. Controls include
Home/app switcher/lock, rotation, shake, supported volume/Action buttons, explicit
Unicode input, appearance and simulator deep links. Capture saves a PNG or stages a
composer attachment without sending. Fit/expanded view and the dependency-free device
shell stay local; the shell preserves actual screen bounds and adds no duplicate island
or Home bar. DeviceKit assets are loaded privately from the target Mac; illustrative CSS is only a missing-asset fallback.

Controls require `iosSimulatorControls: 1` independently of basic preview support.
Text and deep links can contain credentials, so device actions use exact-origin
postMessage followed by the authenticated private preview endpoint, not workspace RPC.
The strict operation/request/control DTO allows only fixed device routes, serializes
commands and bounds successful-request deduplication without retaining raw input.
Screenshot replies bind window/origin/operation/request and transfer at most 16 MiB;
continuous frames still never cross postMessage.

The IPC worker directly owns fixed xcrun commands for pasteboard, appearance, shake
and deep links. Text uses stdin and only presses Cmd-V after successful clipboard
preparation and a fresh lease check. The filtered worker sets a UTF-8 locale for
simctl stdin; otherwise native pbcopy rejects Chinese/Emoji with an encoding error. Foundation.Process creates separate process groups
on macOS; killing Baguette alone would not join those commands, so its corresponding
subprocess routes are deliberately unused. Cancellation joins owned child close before
lease release. New operations acknowledge native portrait once; iframe reconnects keep
the existing rotation. Display, inverse pointer coordinates and capture share rotation.

### Mouse scrolling correction

The initial viewer registered pointer events but no wheel listener, so mouse wheels
and two-finger trackpad scrolling emitted no input. The fixed artifact now converts
wheel deltas into the existing `touch1-down/move/up` protocol, including line/page
units and display scaling. Continuous scrolling lifts and restarts before the screen
edge, ends after 120 ms without input, and yields to an explicit pointer drag.
Blur, hiding and disconnection clear the pending release; Ctrl-wheel does not emulate
pinch. This adds neither a dependency nor a broader native command surface.

`viewer.test.ts` executes the actual emitted script with deterministic browser/timer
boundaries and checks wire output for scrolling, pointer arbitration and cleanup.
Tests execute scrolling and discrete controls at their actual wire boundaries. Live clicks were
observed in the existing Electron preview; the new scrolling artifact and left-button
drag have not yet been validated against a native scrollable screen.

Bottom-to-Home is a separate input gap: Baguette requires `edge: 'bottom'` throughout
the touch sequence, which the original viewer omitted and the gateway rejected.
Pointer starts in the bottom 7% now retain that flag through move/up/cancel, matching
Baguette's normal-orientation mouse band. The gateway permits only this edge, validates
its starting band and rejects changes mid-gesture; forced touch-up preserves it too.
Wheel gestures remain unflagged. Tests cover protocol delivery, cleanup and invalid
edge transitions. Native Home/app-switcher behavior and upside-down orientation have
not been verified. The explicit Home control is separate from bottom-edge gesture handling.

The iframe, its stage and the fixed canvas document disable browser selection and
iOS touch callouts; the iframe/canvas also disable native HTML dragging. Applying the
styles on both sides of the iframe boundary prevents a long press from selecting the
embedded screen without suppressing pointer events or selection in the conversation.
Physical iOS Safari long-press behavior still needs device acceptance.

## Remaining control inventory

| Group      | Controls                              | Boundary                                                 |
| ---------- | ------------------------------------- | -------------------------------------------------------- |
| Input      | Physical keyboard, pinch/multitouch   | Explicit input semantics and native acceptance           |
| Quality    | FPS, bitrate, scale, codec            | Bounded private stream controls                          |
| Capture    | Recording                             | Independent lifecycle and size limits                    |
| Appearance | Text size, contrast, status bar       | Typed controls and native readback                       |
| Lifecycle  | Shutdown, restart                     | Explicit impact on the simulator and other tools         |
| Apps       | Install, launch/terminate             | Explicit project/file access, no arbitrary host commands |
| Debugging  | Accessibility tree, hit testing, logs | Authorized on-demand subscriptions                       |
| Advanced   | Location, network, camera, motion     | Separate injection design and validation                 |

## Architecture and dependencies

`SessionIosSimulatorPanel` owns selection and state; `SimulatorToolbar` uses existing React, StyleX and `@lody/ui`; a connection controller manages RPC/endpoints. A tiny Lody viewer uses canvas, native WebSocket and browser decoders. Do not add Baguette's entire SDK, a media-player library, WebRTC, state library or UI framework.

Render the viewer in a dedicated iframe. Its stream endpoint is same-origin, keeping cross-origin cookies/CORS out of the React controller and avoiding a second React bundle in the CLI. Custom toolbar device actions use the private preview plane; local player commands use a small typed postMessage contract checking exact origin, source, generation and schema. The viewer is a fixed Lody artifact, not a user project page; disable annotation injection. Continuous frames never travel through postMessage, React state, RPC or Loro documents; only explicitly requested screenshot bytes return to the parent.

A lazily started Baguette process captures and injects input on the Mac. Each active preview owns one native process through an IPC worker, loopback only, with plugins disabled. This deliberately avoids a shared native-process refcount and its cross-session cleanup coupling. The Lody adapter exposes only required routes/messages for the bound device. Listing can use `xcrun simctl list devices --json` before Baguette is installed; boot/capture use a pinned adapter. Follow managed-runtime version/hash/license distribution, with no Homebrew requirement. Publish a tested macOS/architecture/Xcode/runtime matrix; unsupported environments fail explicitly.

## RPC and authorization

`lody_ios_simulator_preview` exposes list/start/status/stop separately from web
preview. Its strict input has no identity selectors. The local-only
`ios-simulator/agent-control` route derives the active invocation user and reuses
service authorization. Results exclude viewer URLs and free-form preview diagnostics.

An agent runs on the Mac while its user may view remotely. Selecting loopback during
agent start would give the remote panel an unusable URL. Preparation instead reserves
and boots the device, then waits for the first authorized panel start/status to select
transport. Agent reads do not attach or renew. Cancellation and the one-hour idle limit
release unattended reservations; repeated starts preserve an already attached plane.
This requires no new dependency or durable metadata.

Review caught recovery querying an obsolete operation after an agent replacement.
Panel recovery now reads session-current status; preparation polls and Stop remain
operation-specific. Device-picker Refresh discovers agent starts while already idle.
No automatic panel opening or continuous idle/ready polling was added. Deterministic
tests cover MCP input/output, active-user ingress, deferred attachment, cancellation,
expiry, remote authorization and panel recovery. Live agent-to-native-viewer acceptance
has not been repeated for this entry point.

The version-1 capability is `iosSimulator`. One `ios-simulator/control` method accepts
`list`, `start {udid}`, `status {operationId?}`, and `stop {operationId}`. The shared
schema rejects extra fields. Start returns a preparing operation immediately;
status observes it without renewal. Stop also cancels preparation and names the
exact operation, so delayed commands cannot stop a replacement.

Device controls use narrow typed private operations, never arbitrary Baguette CLI arguments. Negotiate a versioned `MachineMeta.protocolCapabilities` capability; OS controls entry visibility only. Authorize remote listing as well as mutations. Workspace RPC does not authenticate self-reported user IDs: extend short-lived signed proofs to bind workspace/machine/session, UDID, action, operation/endpoint and CLI-instance nonce. Local routing remains independent of hosted authorization; cloud integration stays behind platform/cloud-api ports.

Every media HTTP/WS request checks capability, UDID and the current control lease; input messages also verify that the lease remains valid. Accept only authorized access from the controlling session. No public sharing routes or anonymous viewer grants; removing sharing does not remove authentication. Explicitly carry credentials on WS connection rather than relying on a Referer being present.

## Ownership, state and concurrency

- Key operation queues, cancellation, local/remote endpoints, status and quota records by session plus kind (`browser` / `ios-simulator`). Update every owner, not just the top Map. Session archive/delete cleans both. Reuse QuickTunnelSession/cloudflared primitives instead of copying PreviewService.
- Separate device and connection state. Boot success plus tunnel failure means device running / connection failed; retry connection without booting again. Tunnel readiness is followed by first-frame readiness.
- Confirmed: one controlling Lody session per device across the machine, including across workspaces. Before booting or connecting, the CLI atomically acquires a UDID-keyed control lease bound to workspace/session and a generation. Coalesce repeated starts within the same session and serialize device mutations. Other sessions show “Controlled by another session” and disable preview, with no takeover action. Devices started by native tools may be attached; this coordinates Lody sessions, not native tools.
- Cancelled/failed starts, explicit stop, device switch, idle expiry, revocation, session archive/delete and CLI exit release the corresponding lease. Disable old input and close old endpoints/sockets before allowing acquisition by another session. Lease generations prevent stale cleanup from releasing new ownership. Releasing control leaves the Simulator device running. A failed switch shows a retryable empty state without automatically reacquiring the old device.
- Hiding, switching panel tabs, Zen or closing the panel stops that viewer's decoding/input/renewal, not the endpoint. Reopen through status. Explicit stop, revocation, archive/delete or CLI exit releases owned endpoints/processes. The operation owns its Baguette worker; leave user services and Simulator devices alone.
- Retain a one-hour idle policy, renewed by visible-viewer heartbeats or valid operations, not emitted video frames, status queries or probes. Reconnection resets decoder/keyframe state; never queue touches across disconnection.
- Store selection/preferences locally scoped by account/workspace/session/machine. No lists, frames, heartbeats or endpoint secrets in repo meta. CLI memory owns live endpoints; RPC restores UI. Future cross-client selection can use a small independent session-doc field, not Browser previewConnection or synchronized tokens.

## Code evidence and implementation boundaries

Inspected OSS `b83e2fdec0f7bc871243c138486c6fb1ce5c1007`:

- `packages/components/src/components/sessions/session-side-panel-tab-bar.tsx` defines fixed kinds/options; `session-detail.tsx` owns fixed panels and the sole sidePanelTabs order. Extend persisted layout and mobile drill entry consistently.
- `session-browser-panel.tsx` owns navigation/address/annotation; `managed-preview-surface.tsx` depends on annotation and Browser postMessage, so neither should become the simulator player. General status presentation can be extracted from `preview-connection-status.tsx`, removing address-specific language.
- `apps/cli/src/preview/preview-service.ts` keys activeTunnels, operations, cancellation and publication by SessionId, allowing one remote owner today.
- `local-preview-proxy.ts` calls `onActivity(true)` for WS messages in both directions. Video requires an explicit renewal policy.
- Related decisions: [Quick Tunnel](../../proposed/architecture/2026-09-21-quick-tunnel-preview.md), [optional annotation](../../implemented/bug-fix/2026-09-15-preview-optional-annotation.md). Simulator integration does not remove existing proxy security boundaries.

## Verification and limits

Implement a vertical list→boot→first-frame→interaction→stop/restore/switch path, then recovery and cross-client acceptance. Deterministic coverage includes OS/protocol gating, target routing, cancellation/stale results, independent Browser/simulator owners, exactly one winner for concurrent acquisition across sessions/workspaces, lease release and stale-cleanup isolation, absence of share routes, unauthorized access denial, cross-UDID denial, revoke closing sockets, background frames not renewing, and CLI-death cleanup. Storybook covers languages, narrow layouts and key states.

Real acceptance includes local offline, authorized-session remote Quick Tunnel, iPhone Safari/Capacitor, slow networks/disconnection, FPS and resource use. Validate H.264 decoding, backpressure and keyframe recovery independently; MJPEG success proves neither H.264 nor WAN latency.

The implementation now includes shared schemas/capability, local and remote RPC,
exact-command signed proofs, a machine-wide control lease, cancellable native worker,
restricted media gateway, separate local/tunnel owners, and the UI Designer's panel.
The viewer handshake binds origin, source and operation; it reports real frame dimensions.

Validation includes deterministic ownership/cancellation/idle-expiry and gateway tests,
RPC/proof tests, frontend mapping/controller/routing tests and typechecks. A real local
smoke test enumerated 86 devices, installed the pinned artifact through a local mirror
of the platform route, received a 205,691-byte JPEG, and stopped without shutting down
the simulator. UI Designer checked Storybook in both languages and themes. The complete
new sidebar has not been exercised in a live Electron build, nor has remote/mobile E2E.

Distribution is prepared, not deployed: the private mirror script has a `--runtime baguette`
lane; the pinned release must be mirrored before shipping. Native support is currently
Apple Silicon/macOS 15+, with Xcode and an installed iOS runtime; Intel is not supported.
No npm dependency was added. MJPEG bandwidth/latency is not a performance guarantee.

The device-controls native smoke used a temporary iPhone 16 / iOS 26.2 and the pinned
0.2.1-lody.1 executable. The actual private gateway received a JPEG and successfully
acknowledged Home, app switcher, both rotations, shake, appearance, Unicode text, a
simulator deep link, volume changes, Action and lock. A separate simctl read verified
Chinese/Emoji clipboard contents and dark appearance. The temporary device and owned
processes were removed. This checks native command acceptance and selected readback;
it does not prove every visible button effect or remote/mobile end-to-end behavior.

The controls UI adds a responsive second toolbar row, mobile More menu, model-aware
DeviceKit hardware exterior (with a CSS fallback) and draft-only screenshot attachment. It adds no dependency.
The final bridge tests cover exact reply identity, serial controls, timeout and
navigation/unmount cancellation, and state-before-ack rotation without a double turn.
The viewer's acknowledged absolute angle is the only orientation authority. The UI
Designer checked hardware/control stories in light/dark and narrow/wide layouts;
these checks do not replace a live Electron or mobile acceptance pass.

### DeviceKit exterior and guest keyboard

The panel now reads the bound simulator’s DeviceKit layout and merged bezel through
fixed Baguette routes, normalizes geometry/button hit regions and drops upstream URLs.
The private gateway caches bounded geometry/PNG bytes; the initialized viewer transfers
them to its exact parent. The renderer checks identity, geometry and PNG dimensions,
creates a revocable object URL and rotates the exterior independently of screen pixels.
Missing assets retain the drawn fallback. No asset is bundled or publicly published.

For iPhone/iPad, the owned worker writes device-local
`com.apple.Preferences AutomaticMinimizationEnabled=false` and posts
`com.apple.keyboard.preferences.changed` before the native portrait baseline. This lets
the iOS software keyboard appear with hardware input connected, without device restart
or host-global Simulator preference changes. It does not add host keyboard forwarding.

A temporary native UIKit probe was exercised through the real private viewer: device and
interface orientation changed to landscape, application bounds changed from 393×852 to
852×393, and the software keyboard used landscape layout. The DeviceKit frame aligned in
both directions. The native orientation route is therefore more than canvas rotation;
orientation-locked apps and SpringBoard may decline interface rotation. This is not a
continuous CoreMotion/gyroscope simulator. Whole Electron and mobile E2E remain unverified.

## PR security review

Workspace Streams can be read by other workspace members. Remote viewer URLs therefore travel only as P-256/AES-GCM envelopes to an ephemeral per-request recipient, whose public key is bound into the signed operation. The local direct DTO stays unchanged. Revocation now spans proof validation and startup, stays disabled until explicit re-enable, and owner/machine reassignment closes existing capabilities. Tests reject recipient/context substitution, plaintext wire URLs, and a start resumed after revocation.

The UI contribution was integrated from its dedicated design branch; its Storybook checks covered light/dark, English/Chinese, device selection and interrupted/preparing states. Wire-to-view mapping remains in one model module. Parent integration adds actual frame dimensions, a first-frame timeout, account-scoped preferences and redaction in on-screen errors.

### Idle artwork and authorization diagnostics (2026-10-01)

The earlier CSS fallback is superseded: idle/preparing states also use real DeviceKit assets. Baguette already exposes read-only chrome commands, so an independently gated exterior RPC reads one selected device without starting a viewer or acquiring its control lease. Static artwork is bounded to 256 KiB, strips paths/URLs, and uses a bounded service cache; no frames or secrets enter this response. UI revokes its object URL and rejects stale selections. Missing assets show content without a drawn chassis.

The reported authorization 400 occurs at request-token body validation, before the simulator RPC. Current shared schemas accept signed simulator commands and their recipient key; a deployment retaining the older Browser-only schema rejects them. Local validation plus an explicit backend update diagnostic distinguishes this from Xcode failure. Which deployed backend the report used remains unconfirmed; no deployment was performed.

### Remote latency analysis (2026-10-01; optimization proposal, not implemented)

The steady-state media path is SimulatorKit → Baguette JPEG encoder/WebSocket → simulator gateway → authenticated LocalPreviewProxy → cloudflared → Cloudflare network → viewer WebSocket → createImageBitmap/canvas. Convex and workspace RPC authorize lifecycle operations; they do not relay frames or pointer moves. Pointer input travels in the reverse WebSocket direction; discrete controls use private HTTP through the same tunnel.

At the pinned Baguette revision db17446e, streamWS uses native scale=1 and JPEG quality=0.5. Although StreamConfig declares fps=60, MJPEGStream does not enforce it: each changed surface queues an encode. Sending set_fps alone therefore does not cap this path. set_scale is implemented, but Lody currently neither sends it nor exposes arbitrary reconfiguration through its restricted gateway. Idle unchanged surfaces are already filtered.

The gateway drops incoming JPEGs once its downstream WebSocket bufferedAmount reaches 2 MiB, but that socket ends at a loopback proxy, not at the browser. The proxy's lossless pause/send/resume is appropriate for arbitrary web traffic but can preserve stale video in downstream buffers. The viewer's single replaceable pending JPEG limits only post-delivery decode work. Baguette also has a 4 MiB encoded-frame backlog, and its MJPEG encode dispatch queue has no latest-only bound. These are code-level risks, not measured queue occupancy on the reported WAN.

Proposed order: instrument frame sizes/rates, decode/paint time, gateway-to-viewer RTT/ack age and connector transport; downscale remote output to displayed resolution; cap outgoing frames and keep one replaceable pending JPEG; use bounded receiver credits so loopback writes cannot outrun browser consumption (not stop-and-wait, which limits fps to inverse RTT); resize canvas only when dimensions change and coalesce pointer moves while preserving down/up. Native encode pacing/latest-only work would need a new patched runtime if upstream remains unchanged.

Next, negotiate Baguette's existing AVCC/H.264 with browser WebCodecs and retain MJPEG fallback. The pinned encoder already uses low-latency settings and a five-second GOP, so arbitrary JPEG-style frame dropping is invalid: retain codec configuration, recover with IDR, and bound decoder queues. No new npm dependency is intrinsically required. WebRTC/direct routing is a later topology change with signaling/STUN/TURN costs, not the first fix. QUIC transport underneath a tunnel does not turn WebSocket video into unreliable datagrams.

Validation scope: source trace against the exact pinned Baguette revision; official Cloudflare and browser API documentation. No measurement of the reported client's RTT, throughput, frame age or loss was performed, and no performance improvement is claimed. Example bandwidth/queue-drain calculations in discussion are illustrative, not observations.

### First four latency optimizations implemented (2026-10-01)

The preceding proposal's first four changes are now implemented. The private gateway/viewer
pair uses sequenced JPEGs, cumulative drawn-frame ACKs, a bounded 2–8 frame/byte window and
one replaceable pending frame. It paces sends at 30 FPS remotely (60 locally); it does not
claim to fix native MJPEG encoding cadence. Remote scale follows bounded viewport/DPR via
Baguette's existing set_scale; local resolution remains native. Canvas resize/layout only
runs when needed, RAF schedules decoding, and coalesced pointer/wheel moves retain release
and final coordinates. No generic proxy, authorization, cloud deployment or runtime pin changes.

Numeric samples cover gateway ingress/send, browser receive/draw, decode time, RTT, draw ACK
and outstanding work. Only the bound iframe can supply validated numeric diagnostics to the
panel. At most 60 samples/two minutes are held in memory; the status popover reads them only
while open, and explicit Copy includes the bounded history and age. DevTools and opt-in console
logging complement a 30-second daemon summary. Metrics are never automatic cloud telemetry.

Real isolated iPhone 16 validation with the pinned runtime confirmed a 300×650 viewport changed
JPEGs from 1180×2556 to 294×640 after the next screen update; the browser decoded and acknowledged
them, and the queue drained. This is local functional validation of the remote profile, not a
WAN speed claim. Deterministic tests cover stalled/forged ACKs, latest-only replacement, pacing,
release ordering, numeric-only reports and exact viewer identity. H.264 and native pre-encode
scheduling remain deferred. See the CLI README for the reproducible field-test procedure.

### Congestion feedback correction (2026-10-01)

The initial 512 KiB remote window could represent several seconds of transmission
on a 1 Mbps path. Worse, using the latest probe RTT increased credit and frame age
allowances when the same ordered media connection queued the probe. This corrects
the first implementation, without changing the four-part scope or runtime pin.

Remote credit now uses minimum observed RTT and a conservative per-frame payload
completion estimate, capped at 128 KiB, with byte pacing and no saved idle burst.
Using ACK inter-arrival rate alone was rejected: it measures our own pacing on an
application-limited path and repeatedly applying headroom collapses throughput.
JPEG SOF geometry supplies the observed scale; receiver feedback can downsample up
to 4, aiming for 8 FPS, with slow quality recovery. Local resolution remains native.
Browser diagnostic windows now run independently of queued gateway reports.

A synthetic FIFO 1 Mbps/400 ms path exercises sustained updates, bounded latency,
quality adaptation and the final static frame without sleeps or real networking.
Separate tests cover RTT inflation, idle periods, quality recovery and burst-delivered
reports. These establish controller behavior, not actual WAN speed. JPEG size,
propagation RTT and return-path/decode delay still limit this transport; the estimate
is not a measurement of raw link capacity. Native encode scheduling and H.264 remain
outside this change. Real remote comparison still uses the README field procedure.

### Upright mobile display and idle quality (2026-10-01)

Mobile presentation now opts out of canvas/exterior rotation through the bound init
handshake. Native left/right controls still change guest orientation. A single display
angle controls layout, reported aspect, inverse touch mapping and capture; desktop keeps
following the native direction. This avoids squeezing a landscape phone into a portrait
mobile page and does not simulate gyroscope input.

The adaptive MJPEG version exposed an idle-quality deadlock: SeedFilter suppresses
unchanged surfaces, MJPEGStream.apply only changes config, and its requestSnapshot is
a no-op. Merely increasing resolution therefore never redraws a static screen. The gateway
now reads one bounded, higher-quality JPEG from the bound loopback screenshot route after
two quiet seconds and drained receiver credit. Source/input/config changes fence late
results and cancel queued stills; shutdown joins capture cancellation. No public endpoint,
lease renewal, runtime rebuild or dependency was added. The still shares ordinary frame
credit and can arrive later on a slow connection; continuous animation is not idle.

H.264 remains a recommended next transport, not implemented by this correction. The pinned
Baguette AVCCStream already supplies avcC metadata, key/delta frames, bitrate/scale controls
and force_idr. However, JPEG's arbitrary latest-only drop policy cannot preserve an H.264
reference chain. Integration needs WebCodecs configuration probing, bounded decode queues,
keyframe recovery after drops/reconnect/reconfiguration, bitrate feedback separate from
paint-ACK latency, and MJPEG fallback. Upstream FrameBacklog drops arbitrary old chunks
under pressure, so preserving references only in Lody's downstream queue is insufficient.
The current tiny JPEG window can also become stop-and-wait when a whole JPEG exceeds the
byte budget; a codec switch must revisit this, not copy the controller unchanged.

Sources: pinned `db17446e` MJPEGStream/AVCCStream/FrameBacklog and
[WebCodecs](https://www.w3.org/TR/webcodecs/). Mobile rotation and idle refresh have deterministic
coverage, including late results and close/revocation; real WAN codec benefit is unmeasured.

An isolated iPhone 16/26.2 run verified guest landscape content inside an upright browser
canvas. With deliberately delayed draw ACKs, native JPEGs dropped to 294×640; after the
scene stopped changing, one real screenshot restored 590×1278 while live scale remained 4. The reader received/acknowledged that still and credit drained. This was a loopback
functional test with injected feedback delay, not a WAN throughput or H.264 acceptance test.

### H.264 transport adoption (2026-10-01)

The later implementation adopts the previously proposed H.264 path without changing the
managed runtime or adding a dependency. The private viewer chooses AVCC only when WebCodecs
exists, probes the actual configuration, and falls back once per iframe to MJPEG on unsupported
configuration, decode failure or stream failure. Existing mobile orientation, inputs, captures,
private capability and lease boundaries remain shared. MJPEG retains its sharp idle refresh;
H.264 uses small repeated native deltas and progressive reference updates instead.

The critical difference is encoded-frame dependency. A bounded parser accepts the pinned
VideoToolbox progressive AVC layout, validates SPS/PPS and reads reference frame numbers.
Gaps inside Baguette's own backlog invalidate the downstream chain. Unsupported layouts fail
to JPEG. A separate controller preserves encoded order, abandons stale/overflowed chains,
requests rate-limited IDRs after outstanding credit drains, and carries avcC with every IDR.
The browser decodes in order, drops only decoded output, closes GPU resources, bounds decoder
work and fences late configuration probes after visibility changes or disconnect.

H.264 starts remotely at 600 kbps and at most 2× downsampling; bitrate adapts from ACK queue
delay, not tiny delta size divided by RTT. Its 64-frame / 64–256 KiB remote window permits
pipelining across propagation delay. Quiet small deltas do not justify raising bitrate. At most
64 unsent packets / 2 MiB / one second are retained; IDRs may exceed credit only alone. This
retains a bounded latency/quality tradeoff rather than promising a frame rate. The native
`set_fps` changes the idle pump, not busy surface scheduling; no pre-encode FPS fix is claimed.
Numeric diagnostics expose codec choice, fallback reason, bitrate, queue depth and recoveries.

Deterministic tests cover reference gaps/wrap, invalid layouts, ordered credit, congestion,
decoded-frame disposal/coalescing, unsupported configuration fallback and stale async probes.
An isolated iPhone 16/26.2 plus Chromium decoded 590×1278 H.264 at roughly 30 FPS on loopback
with no decoder errors. This establishes native/browser compatibility, not actual WAN speed or
Safari/iOS WebView support; unsupported browsers retain MJPEG. See subsequent field diagnostics
and the README procedure before drawing conclusions about a particular remote network.

A browser WebSocket shim then imposed 250 ms each way and serialized downstream bytes.
With a continuously scrolling synthetic UIKit page, the 0.6 Mbps run's final samples painted
about 49–55 FPS; the 0.3 Mbps run painted about 32–45 FPS after adaptation to 251–289 kbps.
Both kept 590×1278, no decoder errors or fallback, and bounded queues; keyframe recovery did
occur during adaptation. These 20/30-second experiments exercise the real native encoder and
browser decoder under injected delivery conditions, not Cloudflare/TCP loss, a real WAN,
long-run stability, or arbitrary app complexity. Reproduce on the user's remote link.

Validation isolates inherited Git configuration for Git fixtures; a machine-specific remote URL rewrite otherwise fails an unrelated workspace identity test. The embedded outer check still encounters pre-existing ACP dependency/type errors, and docs check still reports only the existing MCP AGENTS size violation.

### H.264 stall recovery correction (2026-10-01)

Field feedback showed successful H.264 decoding followed by paint/ACK starvation and
eventually generic stream failure, which permanently downgraded the iframe to JPEG.
The report cannot distinguish RAF suspension from a tunnel outage: gateway samples
also became stale. The initial policy conflated transport failure with codec failure.

Decoded output now releases cumulative credit without waiting for RAF. One latest
decoded picture is retained and painted by RAF or a 100 ms visible-only fallback.
Transport failure or eight seconds without socket messages retries H.264 twice with
backoff, then stops for Restore. Unsupported codecs still fall back to JPEG. New
numeric diagnostics separate receive/decode/paint silence and transport outcomes.
No additional dependency, runtime artifact or cloud deployment is required.

Deterministic artifact tests reproduce suspended RAF and transient/silent sockets,
verify bounded resources and retries, and fence hide/old callbacks. These tests do
not establish the cause or resolve every stall on the user's real remote network.

A real isolated iPhone 16/26.2 encoder and Chromium test imposed 500 ms round-trip
delay, 0.6 Mbps delivery, and suspended RAF throughout. The 100 ms fallback painted
roughly 8.5–9 FPS at 590×1278 while decoding 53–57 FPS. An injected all-message
blackout triggered the silence watchdog and one H.264 reconnect; subsequent samples
retained that resolution, no decode errors and no JPEG fallback. This is controlled
fault injection, not proof of the cause of the reported WAN interruption.

### Jitter-tolerant video feedback (2026-10-01)

Later field samples stayed in H.264 with no transport retries or decoder errors,
but bitrate fell from 690 to 150 kbps while ACKs repeatedly returned near the
333 ms baseline. The old controller could cut on one slow ACK after two seconds;
its test called that sustained congestion even though it exercised one keyframe.
A synthetic ordered burst-ACK regression reproduced the collapse.

Decisions now require a complete two-second, eight-ACK window, with 75% slow
observations before a cut. Healthy demand can recover quality slowly; idle gaps
reset evidence and tiny static deltas still cannot justify growth. Existing byte,
frame and age limits bound safety independently. This deliberately tolerates short
bursts while reacting more slowly to newly sustained congestion. Deterministic
tests cover outliers, recurring bursts, sustained congestion and recovery.

Drawing stays latest-only: receiving 30 FPS but drawing fewer does not prove a
rendering fault when packets arrive in bursts. Separate RAF/timer draw counts,
scheduling delay and maximum arrival gap now expose that distinction. Do not claim
that the rendering or real network bottleneck is resolved from these counters alone.

An isolated native iPhone 16/26.2 and Chromium run with injected 500 ms RTT and
0.3 Mbps downstream retained 590×1278, zero decode errors/fallback/retries. Its final
four samples painted about 22–38 FPS; bitrate adapted to 218 kbps and then recovered
to 251 kbps. RAF scheduling averaged 3–5 ms and no timer fallback was needed. This
checks adaptation on a constrained link, not the user's actual WAN or mobile renderer.

### Burst-tolerant decoder recovery (2026-10-01)

A later field report fell back with code 3 despite zero decoder errors, after several
independent bursts. The viewer counted recoveries over the whole connection and
reset a healthy reference chain immediately at decoder capacity. It now waits for
dequeue/output while preserving encoded order and the existing 32-packet / 2 MiB
queue bound. Overflow or three seconds without decoded progress still recovers via
IDR. Three unsuccessful recoveries remain the limit; 30 outputs over three seconds
with gaps no longer than one second clear the budget. One picture or idle time
cannot forgive persistent failure. Reason-specific numeric diagnostics distinguish
queue overflow, stalled output, decoder errors and protocol failures. Deterministic
artifact tests cover burst drain, five separated healthy recoveries, persistent
failure, overflow, stale callbacks and cleanup. This addresses confirmed recovery
policy defects; the report alone does not locate the network batching stage.

A real isolated iPhone 16/26.2 and Chromium test buffered incoming WebSocket messages
into 750 ms batches for 45 seconds. H.264 stayed at 590×1278 with zero recoveries,
fallbacks or decode errors despite over 2,500 submission pauses. Latest-only drawing
was only 2–3.5 FPS in the final samples, as expected under deliberately batched
delivery; this verifies burst tolerance, not smooth playback or the real WAN path.

### Mobile drawer popup ownership (2026-10-01)

The simulator's mobile More menu rendered visibly above its iframe but inherited
`pointer-events: none` from Vaul's body lock: its portal was outside the modal.
Browser hit testing at Home/App switcher rows hit the underlying iframe. The shared
`DrawerContent` now supplies the existing PopupContainerProvider with a boxless
no-drag host inside the drawer, outside scrolling content. This also keeps device
and status pickers within the same focus/interaction boundary without per-control
z-index or pointer-events overrides. The mobile story now includes the actual Vaul
drawer/body; regression tests cover initially open and trigger-opened menus, focus,
selection, dismissal and preserved drawer state. Existing narrower providers still
win through normal context nesting.

### Concurrent local and remote viewers (2026-10-01)

Status previously returned the operation's first viewer URL to every authorized
requester. A phone opening an operation created by local Electron therefore received
Mac loopback coordinates and showed Direct followed by a blank frame. Transport is
now a property of each lazy endpoint; one operation, lease, native process and gateway
remain shared. Local and remote requests receive independent preparation/failure state
and URLs. The gateway's separate remote path chooses remote flow budgets while sharing
control serialization, replay protection and the once-per-operation portrait baseline.

```text
Session operation → one native process + one control gateway
  local request  → local proxy → local gateway path
  remote request → Quick Tunnel + private proxy → remote gateway path
```

A tunnel failure leaves the local endpoint running. Explicit start retries a failed
endpoint after its cleanup, without restarting the operation; polling never retries
failed connections or renews their idle deadline. Stop and session cleanup join both
endpoint owners before releasing the lease. Remote revocation conservatively closes
the whole operation if it has a remote attachment, retaining the prior fail-closed
lifecycle guarantee. Independent gateway instances were rejected because they would
reset and diverge native orientation/control state. No new DTO or runtime artifact is
required. Service regression tests cover both opening orders, concurrent starts,
proof denial, pending-tunnel revocation and failure/retry isolation; real HTTP/WS tests
verify distinct stream budgets, private admission and a single control baseline.
Physical phone/tunnel end-to-end behavior still requires field verification.

The tunnel close result now explicitly distinguishes failed resource cleanup from a
connection failure whose resources were already joined. Only cleanup failure aborts
the remaining local endpoint. An isolated iPhone 16/iOS 26.2 run using the pinned
Baguette artifact delivered H.264 on both gateway paths simultaneously (172 local and
20 remote-profile frames); after closing the remote socket, the local stream delivered
10 further frames. The temporary device and owned processes were cleaned up. This
checks native multi-view capture, not a physical phone or a real Internet tunnel.

Validation: the standalone public full check passed before the final cleanup-outcome refinement (CLI 3,366 tests plus four skipped; components 4,640). The final refinement passed all 208 simulator/preview tests, CLI typecheck/build and quick checks; formatting passed. Outer affected checking remains blocked by existing ACP type/dependency errors, and docs checking retains the existing oversized MCP AGENTS file. This increment was self-reviewed without subagents.

### Device Hub coexistence for navigation buttons (2026-10-02)

Xcode 27 Device Hub suppresses legacy MainScreenButtonsService; Home, double-Home
App Switcher and Lock can report successful dispatch without changing the screen.
A guest HIDVirtualEventService with the CoreDevice button-service properties and
consumer Menu/Power events coexists with Device Hub. The worker now owns a fixed
bundled helper compiled by the host Xcode simulator SDK, one persistent service per
preview/device, with bounded ready/command replies, no uncertain-command replay,
and joined EOF/termination cleanup. Preparation warms the helper before viewing;
failure does not prevent video/touch use. Only the three navigation buttons change.

Runtime compilation avoids a new Baguette artifact and matches the installed SDK,
but adds cold preparation cost and requires a complete Xcode toolchain. The helper
uses private guest HID interfaces and targets Apple Silicon/iOS 17+; older runtimes
can continue previewing but navigation controls can report unavailable. A binary
helper bundled in a future pinned artifact could remove compilation cost. Per-press
process spawning was rejected because it increases interaction latency; restarting
SpringBoard was rejected because it terminates the user's apps. The earlier generic
HingeControl proof is not shipped: this helper registers only a button service and
has explicit replies. No shell/caller source, arbitrary HID codes or device switching
is exposed. A successful native reply confirms event submission, not UI completion.

An isolated Xcode 27/iPhone 17 Pro/iOS 26.2 run verified actual Home, App Switcher
and Lock screens with Device Hub active and unchanged SpringBoard/backboardd PIDs.
Warm App Switcher took about 376 ms and Lock 105 ms; cold compilation/registration
was about 5.5 s before moving it to preparation. These are local measurements,
not remote end-to-end latency. Physical mobile UI and older Xcode remain unverified.

Fault-injection review found and fixed a parent-first process-group leak and a cleanup-error path that could skip native teardown. The final reviewer reran the descendant probe and observed no surviving process. Native cancellation during App Switcher also removed both host simctl and guest helper before device shutdown, with Device Hub active and unchanged system UI PIDs.

Validation: standalone public full check passed (CLI 3,379 passed/four skipped; components 4,640 passed), final CLI build/typecheck and formatting passed. Adversarial security/correctness/scope review and fresh refutation completed; no remaining P0/P1 findings. Outer affected checking retains existing ACP dependency/type failures; docs retains only the existing oversized MCP AGENTS file.

### Retire investigation instrumentation (2026-10-02)

At the user's request, remove the temporary performance panel, two-second samples,
two-minute history, DevTools stats/logging API, periodic gateway media logs and numeric
input-receipt echo. Remove their parser, story, translations and instrumentation-only
tests. Earlier performance sections in this note describe historical investigation;
they no longer describe shipped diagnostic UI. Keep basic connection diagnostics.

Remove sampling-only counters from the flow controllers. Their read-only snapshots
remain available to regression tests and allocate nothing during normal streaming.
Frame ACKs, RTT probes, bitrate feedback windows, watchdogs, bounded decoder queues,
input prioritization and Device Hub-compatible controls are operational behavior and
remain intact. Cleanup does not claim a new network latency improvement.

Validation: standalone public full check passed (CLI 3,377 tests plus four skipped; components 4,638). Final CLI typecheck/build, quick checks and formatter passed; 41 viewer/gateway tests passed after the final unused-argument removal. Parallel security/correctness/scope reviews and a fresh adversarial review found no blockers. Outer affected check retains existing ACP errors; docs retains only the existing oversized MCP AGENTS error. No new physical-device/WAN run was required or claimed for this removal.
