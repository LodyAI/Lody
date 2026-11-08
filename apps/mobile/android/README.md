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

## Push notifications

The native app supports OneSignal (default) and direct FCM. Only the backend
`pushSubscriptions:configuration` response with `selfHostedEnabled: true` selects
FCM; confirmed `false` selects OneSignal. A failed query or malformed response
reports `unavailable` and preserves the last provider selection; it never silently
falls back. Build properties never override that choice. The OneSignal external
identity is `lody-push-v2:<verified user ID>`.

OneSignal uses public app ID `e383bf31-7c8e-4641-b3f6-3486e77b9a82`; override with
Gradle property `LODY_ONESIGNAL_APP_ID` for a separately provisioned app. Its
OneSignal dashboard must have Android/FCM credentials configured for this client.
For direct FCM, supply these **public client options** as Gradle properties from
the Firebase Android app registered for `ai.lody.android`:

- `LODY_FIREBASE_APP_ID`
- `LODY_FIREBASE_API_KEY`
- `LODY_FIREBASE_PROJECT_ID`
- `LODY_FIREBASE_SENDER_ID`

The project [gradle.properties](gradle.properties) contains the default public
Firebase client values for `ai.lody.android`, with their source fields in
`google-services.json`. For another Firebase app, override all four values using
the client whose `client_info.android_client_info.package_name` matches the
application ID, then rebuild. The JSON file itself is not loaded automatically.
Overrides can use Gradle `-PLODY_FIREBASE_…=…` arguments or user-level Gradle
properties. Empty values disable direct FCM registration.

They must match the project used by the backend FCM service account. Never put
service-account JSON or server credentials in the app. A build without these
options still supports OneSignal; selecting direct FCM then reports `unavailable`
rather than silently using another provider. The `.m3e` application ID needs its
own matching Firebase registration when used for push verification.

Registration follows verified account restoration, foreground refresh and FCM
token rotation. The native BetterAuth session is exchanged at
`/api/auth/convex/token` for a short-lived Convex JWT; the registration mutation
requires its actual live `sessionId`. A bare CLI API key is not a push credential. Logout/account replacement cancels and joins registration, opts
out/logs out of OneSignal, clears notification navigation and attempts direct
unregistration before native credentials are discarded. Submitted mutations keep
ownership of their response wait despite caller cancellation, bounded to 15 seconds
each (at most one pending mutation plus one cleanup mutation during logout).
Superseded refreshes retain their predecessor's drain, so cancelling an intermediate
waiter cannot orphan a submitted write. Push HTTP requests disable connection retries
and mark bodies one-shot to prevent automatic mutation replay.
Cancellation is not proof that a server mutation was aborted. Once a network timeout
or failed response occurs, the remote commit remains unknown. A late registration
may commit after unregister or after a subsequent account's registration. A successful
local drain or unregister response does not rule that out. The backend also transfers
ownership by token (`sameToken`), so changing only installation IDs would not establish
a fence. This client retains the existing installation identity and provider
best-effort semantics; it adds no durable uncertainty queue, ID/token rotation scheme,
or backend protocol. The backend's live-session checks reject revoked sessions,
but the client does not claim complete remote-write fencing or delivery isolation
while a timed-out request remains ambiguous. `notifications.status` reports
`cleanup_unconfirmed` when cleanup itself fails; a successful cleanup is only its
own acknowledgement, not proof that every earlier request has stopped.
No service credentials persist in the app.

Android 13+ asks notification permission once after verified sign-in. The `lody`
channel handles direct FCM background alerts; foreground delivery uses the native
service. The backend FCM v1 payload contains both `notification: {title, body}` and
`data` (including `route` and raw `recipientUserId`), plus Android
priority `high`, TTL `300s`, channel ID `lody` and an event-derived notification
tag. Firebase renders the notification payload in background and passes its data
through the launch Intent on tap; the service reads `RemoteMessage.notification`
and `RemoteMessage.data` for foreground delivery. It does not expect data-only
payloads or a top-level workspace/session ID. Both providers route `/<workspace slug>/sessions/<session ID>` into Home,
checking the verified account's workspace membership and requiring an explicit,
nonblank recipient ID exactly matching that account. Foreground FCM display and
the OneSignal foreground lifecycle listener reject missing, blank or mismatched
recipients. The OneSignal listener suppresses display while signed out/unverified
or when direct FCM is selected. There is no legacy recipient-less
Android notification fallback. Both providers
select the exact session only once it appears in that workspace's catalog.
No notification URL is opened in a browser.

Native build/tests do not prove delivery. Before release, verify both providers on
a provisioned device: allow/deny permission, foreground/background/killed delivery,
cold and warm notification clicks, token rotation, provider switching and logout.
Already accepted OS notifications cannot be recalled by backend unregistration.
In particular, background FCM `notification + data` messages are rendered by the
Firebase/Android system path, bypassing the foreground service's local account and
provider checks. An already accepted message can therefore appear after logout,
as with an already accepted APNs alert. Tap navigation still validates the restored
account and membership; this client change does not alter the backend payload or
claim to eliminate that OS delivery boundary.

## Appearance

Dark mode uses soft black (`#111113`) for app/page base and grouped surfaces,
including the launch/window background, aligned with iOS. Light mode stays white;
raised surfaces, translucent scrims/shadows and artwork retain their own colors.
There is no separate pure-black mode. The protocol WebView is offscreen and does
not render app pages.

User messages offer Copy through a long-press menu, with Edit available only for
the latest runtime-confirmed editable message. Conversation titles use the 16 sp
body-emphasis style, clipping overflow with a soft trailing-edge fade rather than
an ellipsis (mirrored in RTL, absent when the title fits). Accessibility retains
the full title. The header shows the computer below the title in secondary text with a presence
icon; tapping it opens the owner/visibility panel. There is no bottom computer capsule. The panel
loads owner and private/shared display metadata from `machines:listVisibleMachines`
through the verified native account and reads current runtime presence on opening.
Missing or failed metadata stays explicitly unknown, never implicitly private.
The conversations button appears only with open child Tabs. More contains New
current working directory conversation and access to closed conversations, so
creation and recovery remain available without the conversations button.

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

Open **Open cloud connection** in the debug launcher, or launch `.diagnostics.CloudProbeActivity`. Open the native Home sign-in, authenticate with email/password, Google, or a provider-only browser OAuth flow, then choose a workspace. See [native authentication and provider configuration](docs/native-auth.md). The screen distinguishes connecting, syncing, live, paused and unavailable states and offers disconnect/sign-out. No desktop token is required or accepted.

See [phase-2 architecture](docs/phase-2-architecture.md) for account, credential, network and grant ownership. The debug cloud probe is excluded from release; real-cloud acceptance is tracked separately from offline fixtures.

### Catalog cache foundation

The debug cloud probe now restores the saved workspace and catalog projection before online synchronization. Cached account context is explicitly unverified and cannot request grants. A failed cloud connection retains cached display. Network validation while foregrounded retries an unavailable read lease. See [cache architecture](docs/catalog-cache.md) and [scope](docs/phase-3-cache.md). Native conversations build on this cached catalog projection.

Local screenshots, recordings and raw verification reports are excluded from Git. Checked-in verification summaries distinguish deterministic tests from real-cloud acceptance and remaining checks.

## Build-time backend configuration

See [backend configuration](docs/backend-configuration.md) for the shared local env file,
process overrides, mandatory TLS and endpoint-isolated storage.

### Conversation usage

The composer displays context consumption and eligible subscription windows beside
Send/Stop, with a details popover and relative/absolute reset-time buttons.
`SessionSnapshot.usage` consumes an optional session-envelope `usage` projection:
`context: { used, size }`, `isContextCompacting`, `quotaEligible`, `modelId`, `modelLabel`, and
`quota: { id, provider, agentConfigId, name?, windows: [{ label?, usedPercent, duration?, resetsAt? }] }`.
Durations and reset timestamps are seconds (reset timestamps are Unix time).
The shared runtime must resolve the selected model/config and apply capability
and authentication eligibility before setting `quotaEligible: true` and emitting `quota`. Older
runtimes without this projection hide the indicator rather than inventing usage.
Runtime delivery of this new projection is coordinated separately from native UI.
