# Lody Mobile

Lody’s new native mobile clients for iOS and Android, developed here alongside
Lody’s desktop app and CLI. Follow agent conversations, create and send tasks,
respond to permission requests, and inspect projects and code changes from your phone.

Conversation rows summarize activity in their internal Tabs, so running work,
permission requests, failures, and unread replies remain visible from the list.
Tabs stay inside their conversation; independently opened child conversations
retain their own status.

The clients are under active development. This source import does not establish
an App Store, Play Store, or TestFlight release for this repository. The mobile
clients currently use Lody Cloud; they are not a mobile frontend for the OSS
desktop’s local-only composition.

## Credits and origins

The iOS client is based on **[Innei’s lody-ios](https://github.com/Innei/lody-ios)**,
and Android reuses its cloud protocol runtime. Thank you to
[Innei](https://github.com/Innei) and the upstream contributors for the native app,
chat experience, and shared runtime. Original licenses and copyright notices are
preserved; [ChatKit](https://github.com/Innei/ChatKit) remains a pinned submodule.

## Repository layout

| Directory | Purpose |
| --- | --- |
| [ios/](ios/README.md) | Swift/UIKit and SwiftUI client; XcodeGen, SwiftPM, and a separate pnpm workspace |
| [android/](android/README.md) | Kotlin/Jetpack Compose client; Gradle and an npm-built protocol runtime |
| `shared/markdown-repair/` | Markdown repair entry used by both clients |

Appearance code and icons are owned by each platform. iOS uses system fonts,
including system monospaced fonts for code; Android bundles Inter and JetBrains Mono. The former shared
design generator and preview project are not included. iOS keeps the existing
`LodyDesignSystem` module API in `ios/packages/LodyAppearance`; Android keeps its
appearance sources and resources under `android/app/src/main`.

## Development

Run these commands from the Lody repository root to initialize the native chat dependency:

```sh
git submodule update --init --recursive apps/mobile/ios/packages/chat-kit
```

Mobile has independent dependency locks and toolchains. The root `pnpm install`,
`pnpm check`, and desktop build do not install or validate the native clients.

### iOS

Use macOS, Xcode 26.5+, XcodeGen, CMake, a repository-supported Node.js version,
and the iOS workspace’s pinned pnpm 11.10.0.

```sh
cd apps/mobile/ios
corepack pnpm install --frozen-lockfile
corepack pnpm ios
```

See the [iOS README](ios/README.md) for architecture, checks, and offline verification.

### Android

Use Android Studio, JDK 17+ (JDK 21 is recommended by the imported setup), Android
SDK 37, and Node.js/npm. Gradle versions are pinned by the wrapper and version catalog.

```sh
cd apps/mobile/android/runtime
npm ci
npm test
cd ..
./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintDebug
```

See the [Android README](android/README.md) for device setup and runtime ownership.

## Push notifications

Both native clients select their push provider from the authenticated backend's
`pushSubscriptions:configuration` response. `selfHostedEnabled: true` selects
APNs on iOS or FCM on Android; `false` selects OneSignal. A failed configuration
read is not permission to switch providers. OneSignal uses the external identity
`lody-push-v2:<userId>`; notification recipients and local account checks still
use the raw user ID.

Provider configuration does not enroll offline devices. Open the updated app and
sign in to register with the selected provider. Direct push registration is bound
to the authenticated login session, not just the account. Keep server credentials
out of either native build. Delivery is best effort; successful registration or a
provider acceptance does not prove the device displayed an alert.

See [iOS push setup](ios/apps/ios/PUSH_NOTIFICATIONS.md) and
[Android setup](android/README.md) for public client configuration and device
verification. The [push boundary decision](../../.agents/notes/implemented/architecture/2026-10-16-direct-push-client.md#native-mobile-clients)
explains provider identity and lifecycle ownership. These native clients are
independent of the shared Web/Capacitor client; adopting them does not update that
client's provider implementation.

## Licenses and acknowledgements

The imported iOS client and shared cloud-runtime code retain their
[AGPL-3.0-only license](ios/LICENSE). Android’s runtime snapshot retains its
[license](android/runtime/vendor/cloud-runtime/LICENSE) and
[provenance](android/runtime/vendor/PROVENANCE.json).
Third-party code and assets retain their own licenses and copyright notices;
this import does not relicense them under the repository’s root license.

Please also see the [iOS acknowledgements](ios/README.md#acknowledgements) for
FlowDown, unixzii, MarkdownView, Litext, Loro, AXe, baguette, and other contributors.
Android’s Inter and JetBrains Mono notices accompany its bundled fonts. Lucide
notices accompany the native icon assets; iOS retains its imported font notices
as attribution history.

The imported platform `AGENTS.md` files retain their existing detailed native
contracts with explicit word-budget exceptions. Splitting those contracts is
separate from this source migration so their ownership is not changed implicitly.
