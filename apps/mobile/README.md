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

**This work builds directly on [lody-ios](https://github.com/Innei/lody-ios),
created by [Innei](https://github.com/Innei) and its contributors.** Their native
iOS client is the foundation of the iOS app here, including its UIKit/Swift UI,
LodyKit application architecture, native chat experience, and browser-safe
Loro/Flock protocol runtime. This is a continuation of substantial upstream work,
not an implementation started from scratch by the Lody team.

The Android client also builds on that work through a provenance-tracked snapshot
of the iOS cloud runtime and shared protocol semantics, with its own Kotlin and
Jetpack Compose UI. Thank you to Innei and all upstream contributors for making
this foundation available. Read Innei’s account of the original project:
[Prototype in a Day, Shipped in a Week](https://innei.in/en/posts/tech/lody-ios-prototype-to-product).

Imported from [Leeeon233/lody-mobile](https://github.com/Leeeon233/lody-mobile)
at [`8dab135b5b5c6e3409390ebde7f57b2b5d52b2b3`](https://github.com/Leeeon233/lody-mobile/commit/8dab135b5b5c6e3409390ebde7f57b2b5d52b2b3).
That repository brought together Innei’s iOS client and
[LodyAI/lody-android](https://github.com/LodyAI/lody-android).
The import preserves source and notices; the linked repositories retain the
original commit history. [ChatKit](https://github.com/Innei/ChatKit), also by Innei,
remains a submodule pinned to `f36df0ef559642715433baf38845e4e06600d784`.

Upstream lody-ios remains an independent project. Please report issues with this
integration to the Lody repository; inclusion here does not imply upstream
maintainers support this fork.

## Repository layout

| Directory | Purpose |
| --- | --- |
| [ios/](ios/README.md) | Swift/UIKit and SwiftUI client; XcodeGen, SwiftPM, and a separate pnpm workspace |
| [android/](android/README.md) | Kotlin/Jetpack Compose client; Gradle and an npm-built protocol runtime |
| `shared/markdown-repair/` | Markdown repair entry used by both clients |

Appearance code, icons, and fonts are owned by each platform. The former shared
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

## Licenses and acknowledgements

The imported iOS client and shared cloud-runtime code retain their
[AGPL-3.0-only license](ios/LICENSE). Android’s runtime snapshot retains its
[license](android/runtime/vendor/cloud-runtime/LICENSE) and
[provenance](android/runtime/vendor/PROVENANCE.json).
Third-party code and assets retain their own licenses and copyright notices;
this import does not relicense them under the repository’s root license.

Please also see the [iOS acknowledgements](ios/README.md#acknowledgements) for
FlowDown, unixzii, MarkdownView, Litext, Loro, AXe, baguette, and other contributors.
Inter, JetBrains Mono, and Lucide notices accompany the native appearance assets.

The imported platform `AGENTS.md` files retain their existing detailed native
contracts with explicit word-budget exceptions. Splitting those contracts is
separate from this source migration so their ownership is not changed implicitly.
