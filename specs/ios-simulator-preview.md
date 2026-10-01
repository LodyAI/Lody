# iOS Simulator preview

Status: draft
Translation: current

[中文](ios-simulator-preview.zh.md)

A session assigned to a macOS machine can open an iOS Simulator panel beside Browser.
The list comes from that target machine, independent of the viewer's OS. Listing is
read-only: no download, boot or tunnel. Show unavailable runtimes and device occupancy.
A stopped device offers Start and preview; a running device offers Preview.

The panel contains a device selector, connection status and an aspect-fit interactive
screen. Connection details offer cancellation, retry and stop. Hide addresses, browser
navigation and annotation. Simulator preview has no sharing controls, public links or
anonymous viewing. A second desktop toolbar row contains Home, app switcher, lock,
rotation, shake and device-supported volume/Action controls. Mobile places actions in
More. Explicit text input, simulator deep links and light/dark settings use the private
preview connection, never retained workspace RPC. New controls require the independent
`iosSimulatorControls: 1` capability.

Use the target Mac’s DeviceKit exterior through Baguette, preserving exact screen and
button geometry; show content without a drawn shell if those assets are unavailable.
Transfer bounded images privately, without publishing or bundling Apple assets.
Desktop follows actual display aspect/rotation. Mobile keeps the exterior and canvas upright while native orientation changes the guest interface; do not cover streamed pixels with another notch or
Home indicator. Fit and expanded views are local UI state. Capture can save a PNG or
attach it to the current composer draft; it never automatically sends a message.
Only the bound iframe and matching request may return bounded screenshot bytes.

On iPhone/iPad preview preparation, enable the guest software keyboard to appear when
an input is focused, even with a hardware keyboard attached. Change only that device’s
keyboard preference; do not reboot it or change host-global Simulator settings. Rotation
sends the native device-orientation event; apps may restrict their supported orientations.

Same-machine Electron uses direct local transport, including offline operation. Remote
viewing by the authorized session uses Quick Tunnel internally. Both routes authorize
access; remote control binds a short-lived proof to the exact session, device/operation,
action and daemon instance. OS controls discoverability; a versioned machine capability
controls compatibility. Public local-only builds make no authenticated cloud calls.

Each device allows only one controlling Lody session across all workspaces on the
machine. Other sessions show occupied, with no takeover. Native Simulator tools remain
outside this coordination. Browser and simulator previews coexist independently.
Repeated starts coalesce. Stop also cancels preparation; stale completions cannot restore
a cancelled connection. Switching devices releases the previous device. Cleanup closes
viewers and owned native processes before releasing control, but never shuts down a
Simulator device. Session archive/delete and daemon exit clean up their operations.

Hidden viewers stop decoding, input and heartbeat. Hiding does not immediately end the
operation. The connection expires after one hour without foreground heartbeat or valid
input; emitted video, polling and probes do not renew it. Devices/frames/endpoints are
in-memory runtime state; selected-device preferences are client-local and scoped to the
account/workspace/session/machine. Credentials never enter session documents.

The viewer prefers H.264 with WebCodecs, probes the actual decoder configuration,
and falls back to MJPEG on codec incompatibility or decode failure. Transient transport
failures get bounded H.264 reconnection before requiring Restore, without permanent
codec downgrade. Hiding cancels recovery; controls are never replayed. Both use bounded queues
and receiver feedback, with single-pointer input, including mouse drag and wheel/trackpad scrolling translated into a finger drag.
Scroll input and pointer drag never hold separate simultaneous touches; hiding,
disconnecting or losing focus releases the active gesture.
Dragging upward from the bottom edge carries a system-edge gesture for Home;
ordinary wheel scrolling remains an in-app gesture.
Multi-touch, physical-key forwarding and advanced device configuration remain later work.
Each new operation acknowledges a portrait baseline; reconnecting the same operation preserves rotation.
Readiness separates preparation/transport from the first decoded frame.

Agents use `lody_ios_simulator_preview` for native apps, separate from the web tool
`lody_report_preview_candidate`. Actions are `list`, `start {udid}`,
`status {operationId?}` and `stop {operationId}`. Machine/session context is implicit;
the daemon derives the requester from the active turn and checks session ownership.
Tool output excludes viewer credentials. This tool does not build or install apps.
An agent start prepares the device asynchronously; the first authorized panel selects
local or remote viewing. Agent status cannot attach a viewer or renew the lease.
An unattended start expires after one hour. Opening/reopening the panel or using its
device-picker Refresh discovers the current operation; preparation polls and Stop
remain operation-specific. The tool does not automatically open the panel.

Evidence: [design note](../.agents/notes/implemented/architecture/2026-09-27-ios-simulator-panel.md),
[CLI boundary](../apps/cli/src/ios-simulator/AGENTS.md). Implementation and validation are
recorded in the note; this draft does not claim human approval or deployment.

Remote viewer credentials are encrypted to an ephemeral requester key bound into the signed command. Other workspace members cannot recover them by reading retained RPC streams. Revocation covers in-flight authorization; owner or machine reassignment invalidates existing viewers.

## Exterior before preview

Selecting a device loads its real DeviceKit artwork before starting preview. The separately negotiated, authenticated `exterior {udid}` command reads Baguette chrome layout/composite without booting, reserving the device, streaming or opening a tunnel. One bounded immutable PNG and normalized geometry may cross RPC; live screen pixels and input never do. Resources are not published or persisted in Repo metadata. While artwork is loading or unavailable, show content without an artificial hardware frame.

Remote authorization depends on the connected Cloud backend understanding the exact signed simulator operation. Validate outgoing intents locally; a 400 for a valid simulator request indicates a backend protocol rejection, with a matching-backend update hint and no insecure fallback.

## Remote responsiveness and diagnostics

Size remote video for its visible viewport with bounded pixel density and frame rate.
On slow links, reduce sharpness and pace bytes using receiver feedback; recover quality
slowly. In MJPEG mode, after input and animation settle, refresh one sharper still
even when the native stream emits no new frames; discard stale capture when activity
resumes. H.264 continues refining its reference picture through the video stream.
Congestion-inflated RTT must not increase the outstanding byte budget.
Bound unconfirmed video. JPEG may replace unsent frames; H.264 must preserve encoded
references or discard the affected chain and resume on a keyframe, including upstream
loss. Only decoded video pictures may be coalesced; decoding confirmation releases video
credit independently of the browser paint cadence, with at most one unpainted picture;
retain final pointer positions and releases when merging high-frequency moves.
Same-machine preview preserves native resolution. No new cloud service participates
in the media path. Connection status exposes numeric performance diagnostics, with
an explicit copy action and bounded in-memory history; never collect input or pixels
in these diagnostics. Disconnected samples remain distinguishable from live measurements.
