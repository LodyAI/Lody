# Android emulator preview

Configured AVDs use the shared [device preview core](../device-preview/README.md).
ADB resolves the exact case-sensitive AVD name to one `emulator-*` serial. Physical
devices and ambiguous duplicate AVD instances are excluded. Install the Android
SDK and create AVDs separately; Lody does not install SDKs or create devices.
Stopping preview never shuts down the emulator or the user's ADB server.

Tango talks to loopback ADB on port 5037. The owned TCP connector settles reads and
writes on abort/error/close. Every capture has an isolated scrcpy connection ID;
control cancellation closes its native connections before joining pending work.
Clipboard input is explicit Unicode paste, with a bounded ACK wait. Touch supports
one or two pointers. Navigation is Back/Home/Recents. Rotate uses scrcpy's native
rotation toggle. Light/Dark changes Android system night mode through a fixed
ADB `cmd uimode night` command; apps with their own theme overrides may not follow it.
iOS-only controls are unavailable. Audio and clipboard autosync
are disabled. APK installation and arbitrary shell commands are not exposed.

The encoder is fixed to H.264, 1 Mbps, 30 FPS maximum and a 1280-pixel maximum
edge. Per-viewer credits and recovery use the common flow controller; viewers do
not compete to configure the encoder. Annex-B SPS/PPS and frames are converted to
avcC/AVCC at this adapter. Android requires WebCodecs H.264 and has no MJPEG fallback.

## Runtime release boundary

scrcpy-server 3.3.3 is pinned by exact size and SHA-256 in `runtime.ts`. Cache hits
are verified; downloads use the injected public managed-runtime base URL. No PATH
scrcpy, npm executable, latest-version resolution or unsigned fallback is used.
Tango versions are locked; stream-extra is deduplicated because Consumable uses
class identity across the ADB and scrcpy packages.

Prepare the official release artifact with:

```
node scripts/package-scrcpy-runtime.mjs /path/to/scrcpy-server-v3.3.3 /path/to/output
```

The public runtime channel must publish the manifest path before a clean install
can start preview. This repository prepares the artifact but does not deploy that
channel. Remote authorization also needs the external signer to accept the exact
`android-emulator` operation. Public desktop stays local-only. Tests using an
explicit official server file do not verify channel deployment or remote TURN.

An opt-in real-device smoke test uses an already configured AVD:

```
LODY_E2E=1 LODY_TEST_AVD=Pixel_8 LODY_TEST_SCRCPY_SERVER=/path/to/scrcpy-server-v3.3.3 pnpm --dir apps/cli exec vitest run tests/android-preview.e2e.test.ts
```

The local Pixel_8 smoke received a framed H.264 keyframe and completed gateway and
capture cleanup on macOS. Linux/Windows hosts and real remote/mobile networks
remain unverified.
