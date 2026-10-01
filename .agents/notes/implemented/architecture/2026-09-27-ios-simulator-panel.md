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
