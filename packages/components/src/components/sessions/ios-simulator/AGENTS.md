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
- Every machine call is `runtime.requestIosSimulatorControl` (`ios-simulator/control`).
  The UI never builds proofs or tokens, never displays `viewerUrl` or a tunnel address,
  and maps wire DTOs only in `lib/ios-simulator/ios-simulator-model.ts`.
- The viewer keeps its own origin for the exact-origin handshake, so a `viewerUrl` that
  is not http(s) or shares the app's origin is rejected, never rendered. Accept viewer
  `state` only from that frame's window, origin and operation.
- One Session controls a device: never offer a takeover of an occupied device. Stop and
  Cancel are `stop{operationId}`; they end the preview only, never shut the device down.
- Poll only while preparing, bounded, and only while on screen. A hidden panel keeps
  the viewer mounted and sends `visibility`; unmount never stops a preview.
- Recovery and explicit Refresh discover session-current status, including agent
  replacements. Preparation polls and Stop stay bound to their exact operation id.
- Same-machine Electron is never blocked by cloud presence reporting its machine
  offline.
- Native controls are `device-control` on the exact ready operation id, gated by
  `machineSupportsIosSimulatorControls`. What a device lacks stays listed and disabled
  (`getIosSimulatorControlAvailability`); without the protocol, say so once.
- The exterior (`ios-simulator-device-frame.tsx`) is drawn only outside the streamed
  screen: never a notch, island or home indicator over pixels, and never a rotated
  iframe. It turns only after a confirmed rotate, and snaps to the stream's own shape.
- A screenshot is the viewer's `capture` answer bound to its frame, origin, operation
  and request id, a PNG of at most 16 MiB within 10 s. It joins the current composer
  as an attachment and is never sent for the person. No share, public viewer or
  open-in-browser. Typed text and URLs are submitted forms; read the clipboard only
  on an explicit Paste.
