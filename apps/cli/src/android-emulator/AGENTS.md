# Android emulator adapter

CLI and device-preview contracts apply. This directory owns AVD discovery, SDK
access and the pinned scrcpy connection. The shared device-preview core owns viewers.

- Select configured AVD names exactly and resolve their actual serial. Never select
  the first device or expose physical devices implicitly. Reject duplicate AVD instances.
- Listing does not boot an emulator or download a runtime. Stop preview never kills
  an emulator or the shared adb server.
- Keep scrcpy server bytes and Tango versions pinned. Downloads use the public runtime
  channel and verify size/hash before execution on the device.
- Input is a bounded typed private channel. Never accept caller shell strings,
  upstream addresses or arbitrary file paths. EOF/close releases touches.
- Own every ADB socket and join its close on cancellation. Never release a device
  lease while its capture/input connection remains live.

- Appearance uses only fixed `cmd uimode night yes/no` commands on the capture’s
  bound ADB connection. Check exit status and confirmed mode; cancellation shares
  native connection revocation with other preview controls.
