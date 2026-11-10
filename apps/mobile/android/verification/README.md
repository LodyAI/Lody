# Offline runtime verification — 2026-10-28

Environment: Pixel_8 emulator, Android 14 (API 34), arm64; Google WebView 149.0.7827.91.

- JavaScript dispatcher tests: 4 passed.
- Kotlin watchdog tests: 3 passed.
- Android instrumentation tests using real WebViews: 8 passed.
- Debug/release APK builds and debug/release-vital lint completed successfully.
- The native debug screen shows 7/7 compatibility checks passed.
- Release APK excludes DebugRuntime.html and includes production runtime plus licenses for all bundled runtime dependencies, including both Streams Client versions in the lockfile.

The native tests cover real WASM, Unicode request correlation, stop/cancellation and stale generations, pending request timeout, background retention, navigation rejection, missing-asset recovery limits and JS-stall watchdog recovery.

`results.json` records test counts, dependency-license inventory and remaining non-blocking lint findings. The expected reminders are target SDK 36, the pinned AGP-compatible Gradle/Kotlin versions, missing final app icon and Android 12+ backup rules. No credentials or user content are in this app.

`evidence/checks.png` is a real emulator screenshot. `evidence/recovery.mp4` records JS-stall recovery. These show a diagnostic screen, not a finished product design.

Reproduce with `npm ci && npm test` in `runtime/`, then `./gradlew :app:testDebugUnitTest :app:assembleDebug :app:assembleRelease :app:lintDebug :app:connectedDebugAndroidTest` at the root with a connected Android device.

Limits: one emulator/WebView combination only. Not a cloud/CORS/login/synchronization or physical-device validation. Actual renderer process termination is handled but not fault-injected in this run. The upstream Zod audit finding must be resolved before enabling untrusted cloud data; see `docs/runtime-architecture.md`.
