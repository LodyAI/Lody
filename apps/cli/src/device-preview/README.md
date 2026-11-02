# Shared device preview core

`DevicePreviewService` owns ephemeral operations, per-platform session queues,
lease generations, idle expiry and authenticated local/remote endpoints. Each
platform has its own service instance, so iOS and Android can coexist in a session.
Machine-wide lease keys include platform and the adapter's normalized device ID.
The iOS wrapper preserves its original UUID/UDID wire contract; Android has a
separate case-sensitive AVD contract and capability. Browser preview remains an
independent owner.

Adapters provide discovery, boot, runtime preparation and a capture connection.
The common gateway owns the private viewer, bounded input validation, controls,
WebSocket/WebRTC DataChannel transport and flow control. H.264 travels over a
DataChannel, not a WebRTC video track. Canonical decoder configuration and encoded
frames enter `DeviceH264Flow`; Baguette reference parsing stays in the iOS adapter,
and Android converts scrcpy Annex-B at its boundary. The common WebCodecs viewer
retains iOS MJPEG fallback and rejects it for Android.

Stopping revokes endpoints before releasing capture. A failed capture shutdown
retains only that device's lease until the machine worker restarts; safe endpoint
cleanup failures do not fence unrelated devices. Native controls receive a
cancellation signal so gateway shutdown cannot wait forever for a device ACK.

The React `SessionDevicePreviewPanel` shares catalog, lifecycle polling, private
viewer, screenshots and control UI. Platform selection keeps state and preferences
independent. Legacy iOS presentation types remain internal compatibility shapes;
Android lifecycle wire fields are `id`, never `udid`. Screenshot attachment only
adds a draft attachment and never sends a message.

The [simulator architecture decision](../../../../.agents/notes/implemented/architecture/2026-09-27-ios-simulator-panel.md#shared-android-adapter-boundary) explains the shared boundary and why Android uses an isolated scrcpy adapter.
