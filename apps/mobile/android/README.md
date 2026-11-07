# Lody Android

Lody’s native Kotlin/Jetpack Compose client. It supports account authorization,
workspace and project browsing, conversations, task creation, attachments, and
native permission controls. The browser protocol runtime is derived from
[Innei/lody-ios](https://github.com/Innei/lody-ios); see the
[mobile credits](../README.md#credits-and-origins) and
[runtime provenance](runtime/vendor/PROVENANCE.json).

## Run

Use Android Studio Rabbit 1 / AGP 9.4.1, Gradle 9.6.0 and JDK 17+ (validated with the IDE's embedded JDK 21). The Kotlin and Compose compiler versions are pinned together in `gradle/libs.versions.toml`. Compile SDK 37, target SDK 36, minimum SDK 26. Application ID: `ai.lody.android`.

The local installed IDE was 2025.3 at bootstrap; upgrade it before IDE sync with this AGP. Local SDK paths stay in ignored `local.properties`.

Install Node.js 22+ and npm, then:

```sh
cd runtime
npm ci
npm test
cd ..
./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintDebug
./gradlew :app:installDebug
adb shell am start -n ai.lody.android/app.lody.android.diagnostics.RuntimeProbeActivity
```

Gradle generates runtime assets from the vendored snapshot, pinned npm dependencies and Android adapter before packaging. Dependency licenses are bundled alongside the HTML. No dependency on an iOS checkout, login or connected machine is required.

The debug launcher automatically runs compatibility checks and provides Run, Restart, Watchdog recovery, Stop, Details and Switch workspace buttons. Background the app and return to check lifecycle retention. Debug builds can be inspected via `chrome://inspect`; release builds exclude the diagnostic Activity, diagnostic HTML and fault injection.

## Verification

With an emulator or device connected:

```sh
./gradlew :app:connectedDebugAndroidTest
```

Tests use real Android WebViews, not mocked JS. See Gradle HTML reports in `app/build/reports/` and the checked-in verification summary for actual device coverage. A passing local probe does not claim authenticated cloud synchronization works.

## Architecture and next integration steps

Decisions are in [AGENTS.md](AGENTS.md); details, lifecycle guarantees and current limitations are in [runtime architecture](docs/runtime-architecture.md).

The host interface is replaceable and uses typed coroutine commands, status, events and errors. The Application owns account/workspace leases; Activity recreation and navigation preserve the runtime. Native authentication uses OkHttp and Keystore-backed encrypted credentials. CatalogRepository owns the display projection; a replaceable AtomicFile store caches synchronized catalogs. Dependencies are constructed explicitly in the Application. Native product navigation, message history and sending use that runtime boundary. The shared Zod dependency is pinned to patched 4.6.7 with compatibility tests and a clean production dependency audit.

Phase-1 reports are in [verification/results.json](verification/results.json). On the installed debug app, `python3 verification/phase1-device.py` verifies a real Home/background transition, navigation, workspace switching and force-stop/relaunch; set `ADB` and `ANDROID_SERIAL` for another caller-owned device. It saves screenshots and a short video under `verification/evidence/phase-1`.


## Phase 2 cloud probe

Open **Open cloud connection** in the debug launcher, or launch `.diagnostics.CloudProbeActivity`. Sign in through official Device Flow, authorize this Android app independently in your browser, then choose a workspace. The screen distinguishes connecting, syncing, live, paused and unavailable states and offers disconnect/sign-out. No desktop token is required or accepted.

See [phase-2 architecture](docs/phase-2-architecture.md) for account, credential, network and grant ownership. The debug cloud probe is excluded from release; real-cloud acceptance is tracked separately from offline fixtures.

### Catalog cache foundation

The debug cloud probe now restores the saved workspace and catalog projection before online synchronization. Cached account context is explicitly unverified and cannot request grants. A failed cloud connection retains cached display. Network validation while foregrounded retries an unavailable read lease. See [cache architecture](docs/catalog-cache.md) and [scope](docs/phase-3-cache.md). Native conversations build on this cached catalog projection.

Local screenshots, recordings and raw verification reports are excluded from Git. Checked-in verification summaries distinguish deterministic tests from real-cloud acceptance and remaining checks.
