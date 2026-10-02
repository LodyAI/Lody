# components/sessions/ios-simulator

`CLAUDE.md` symlinks here. Edit `AGENTS.md` only. Parent rules apply.
Decision and rationale:
[iOS Simulator panel note](../../../../../../.agents/notes/implemented/architecture/2026-09-27-ios-simulator-panel.md).

- The iOS Simulator is its own side-panel tab (`ios-simulator`, mobile `?simulator=1`),
  never a Browser mode: no address bar, history, annotation or sharing, and no state
  shared with `SessionBrowserPanel`.
- The tab exists only when the Session's TARGET machine is a Mac; read that and the
  protocol capability through `getIosSimulatorPanelAvailability` only. An old Mac keeps
  the tab and asks for an update without calling it.
- Lifecycle calls are `runtime.requestIosSimulatorControl` (`ios-simulator/control`).
  The UI never builds proofs or tokens, never displays `viewerUrl` or a tunnel address,
  and maps wire DTOs only in `lib/ios-simulator/ios-simulator-model.ts`.
- The viewer keeps its own origin for the exact-origin handshake, so a `viewerUrl` that
  is not http(s) or shares the app's origin is rejected, never rendered. Accept viewer
  `state` only from that frame's window, origin and operation. For an opaque desktop
  origin, transfer a fresh MessagePort to the exact viewer origin on load; route all
  later traffic through it. Close/fence ports and cancel replies on reload/unmount.
- One Session controls a device: never offer a takeover of an occupied device. Stop and
  Cancel are `stop{operationId}`; they end the preview only, never shut the device down.
- Poll only while preparing, bounded, and only while on screen. A hidden panel keeps
  the viewer mounted and sends `visibility`; unmount never stops a preview.
- Recovery and explicit Refresh discover session-current status, including agent
  replacements. Preparation polls and Stop stay bound to their exact operation id.
- Same-machine Electron is never blocked by cloud presence reporting its machine
  offline.
- Disable browser selection, native dragging and iOS touch callouts on the viewer
  surface (outer frame and inner CLI canvas document); keep this scoped to the screen.

- Discrete controls and captures use the existing private viewer capability, not
  lifecycle RPC. Bind replies to the exact iframe window, origin, operation and
  request id; bound waits and cancel pending replies on navigation/unmount.
- Viewer state is the sole rotation authority: width/height are display-oriented,
  and `rotation` is the acknowledged absolute angle. Never rotate again on a
  control acknowledgement. Mobile init disables display rotation: bezel/canvas remain
  upright while native orientation commands still run. Desktop follows the device.
- Prefer DeviceKit geometry/PNG supplied by the bound viewer; never fetch asset URLs
  from upstream metadata. Validate frame/origin/operation and PNG bounds, and revoke
  generated object URLs on replacement/unmount. Before preview, request static artwork
  with `exterior {udid}` only when `iosSimulatorExterior: 1` is advertised.
  Product states never substitute drawn hardware; while missing/loading show only content.
- Hardware outlines and buttons stay outside streamed pixels. Use deviceType as
  model identity, with device name only as fallback; no duplicate notch/island.
- Desktop controls use a second toolbar row and fold with width; mobile puts them
  in More. Unsupported hardware buttons stay disabled.
- Screenshots are bounded PNG bytes from the viewer; attaching targets the original
  Session composer and never sends a message. No public preview/share action.

- `iosSimulatorPreviewRequestId` is a UUID-only agent-start discovery hint, not live
  status or authority. It enables the composer action. Visible desktop conversations
  consume each request once per browser tab in sessionStorage; mobile stays opt-in.
  Side Chat actions bind the exact originating Session; the panel owner override is
  fenced to its parent/top-tab selection. Closing the sidebar never starts/stops a device.
