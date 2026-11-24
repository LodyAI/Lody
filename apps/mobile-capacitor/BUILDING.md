# Mobile builds and releases

## Local native commands

Run from the repository root with `pnpm --filter @lody/mobile-capacitor <command>`:

| Environment | iOS           | Android           | Vite mode |
| ----------- | ------------- | ----------------- | --------- |
| Development | `dev:ios`     | `dev:android`     | `dev`     |
| Staging     | `staging:ios` | `staging:android` | `staging` |
| Production  | `build:ios`   | `build:android`   | `prod`    |

Each command builds web assets, syncs Capacitor, and opens the native IDE.
Environment-specific local overrides belong in `.env.<mode>.local`; keep
development backend URLs out of `.env.staging.local`. For physical devices,
any localhost service URL must be replaced with an address reachable from the device.

## iPhone Duo

Full-display builds require **Xcode 27.1 / iOS SDK 27.1 or later**, with an
**iOS/iPadOS 16.4** deployment target. Select Xcode with `DEVELOPER_DIR` or
`xcode-select`, then run:

```sh
pnpm --filter @lody/mobile-capacitor check:ios:duo
pnpm --filter @lody/mobile-capacitor build:ios:duo
```

The Duo entry checks the selected SDK before the standard production build,
sync and open steps.

The iOS publishing toolchain update selects `xcode-27` and Xcode 27.1 in
[PR #3888](https://github.com/loro-dev/lody/pull/3888). Nightly iOS uses
`publish-ios.yml`. See the [implementation note](notes/2026-10-27-iphone-duo.md).

## CI release versioning

Client publishing workflows are migrated separately. This package supplies the
Capacitor build/sync commands; importing it does not enable publishing.
Stable reads its version from `apps/mobile-capacitor/package.json`. Nightly retains
the same native identifiers, so Android version codes must remain comparable with
Stable. The iOS build-number helper queries App Store Connect and increments the
largest build number for the selected prerelease version.

## Build compatibility

- The minimum deployment target is **iOS / iPadOS 16.4**, matching the
  Tailwind CSS 4 browser floor. Keep the Xcode project, App, notification service,
  widget targets (Debug and Release), and `ios/App/Podfile` aligned. A native
  deployment target does not provide missing JavaScript APIs; follow the
  [mobile compatibility rules](AGENTS.md#minimum-ios-compatibility) for WebView
  and Worker code too.

- `loroCrdtBundlerAlias()` returns an array of Vite alias entries. Compose additional
  aliases as an array; spreading it into an object silently loses the WASM alias
  and selects the unsafe synchronous browser loader.

- `nightly:ios` / `nightly:android` use the same Vite `prod` mode and native sync/open
  steps as `build:*`; only icons change. `scripts/set-app-icon.mjs` derives ignored
  native assets from Electron's `resources/icon-nightly.png`, selects the native icon,
  and generates the iOS settings preview (`LODY_MOBILE_NIGHTLY_ICON=1` Vite alias).
  `ci:sync:ios:nightly` / `ci:sync:android:nightly` select these icons without
  opening Xcode/Android Studio. Standard `build:*`, `dev:*`, `staging:*`, and non-Nightly
  `ci:sync:*` commands reset native icon selectors.
  Preserve this reset so a local Nightly selection cannot leak into a stable build.
  App identifiers, names, URL schemes, and backend environment stay unchanged.

- `vite.config.ts` must use the public fixed top-level-await transform at
  `packages/components/vite-top-level-await-fixed.ts`. The upstream 1.6.0 transform
  can turn hoisted exported functions into late assignments in the shared app
  chunk; Recharts/D3 then crashes during native app boot before React mounts.

## iOS app icons

- `src/app-icon.ts` installs the iOS-only `__LODY_APP_ICON__` bridge for the shared
  Appearance settings picker. Icon identifiers, display names, and previews belong to the native host.
- `LodyAppIconPlugin.swift` reads iOS state and switches between `default` (nil)
  and `AppIconBlue`. Keep its allowlist, JS catalog, and Debug/Release
  `ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES` aligned. No synced preference.
- The 128px previews in `src/assets/` are derived from the corresponding 1024px
  icons under `ios/App/App/Assets.xcassets/`; refresh both when replacing artwork.

## iOS Live Activity

- Native Live Activity bridge/widget files live in `ios/App/App/LodyLiveActivityPlugin.swift`
  and `ios/App/LodyLiveActivityWidget/LodyLiveActivityWidget.swift`.
- Dynamic Island compact/minimal marks are `LodyCompactIslandMark` and
  `LodyMinimalIslandMark`; keep dot/count badge drawing inside each mark's frame because
  ActivityKit clips those regions tightly when the island is minimized.

## Optional native iroh binding

Build the public binding with `pnpm --filter @lody/iroh-native build:ios` or
`build:android` before syncing the selected native platform. Generated artifacts
stay under `packages/iroh-native/mobile-dist/` and are not committed.

On iOS, `ios/iroh-pod.rb` includes a local `LodyIrohBindings` Pod only when both
the xcframework and generated Swift source exist. It links `SystemConfiguration`
for the Rust library's system proxy and interface reads. The App target always
contains `LodyIrohPlugin.swift`, guarded by `canImport(LodyIrohBindings)`.
Run `cap sync ios` after adding or removing the generated binding; use ordinary
`pod install` rather than `--deployment` when changing this optional local Pod.
Keep the committed Pod lockfile in its default, no-binding configuration.

Android includes the Kotlin plugin source and JNI libraries only when both
generated directories exist. Builds without bindings, or without a
`VITE_IROH_RELAYS` configuration, keep encrypted Streams RPC.

## iOS Simulator widget checks

- The native logo and surface/status colours live in
  LodyLiveActivityWidget/LodyWidgetAppearance.swift, shared with Live Activities.
  Keep the mark's full-colour rendering and running/waiting/unread colours aligned.

- On an Apple Silicon Mac, install an iOS runtime with
  `xcodebuild -downloadPlatform iOS -architectureVariant arm64`. Check the installed
  identifier with `xcrun simctl list runtimes`, create an iPhone in Simulator, and
  wait for `xcrun simctl bootstatus <device-id> -b` before installing the app. The
  first boot prepares system caches and can take several minutes.
- Install CocoaPods (`brew install cocoapods`) before the first Capacitor sync.
  `pnpm --filter @lody/mobile-capacitor exec cap sync ios --deployment` retains the locked
  native dependencies.
- Supply the existing staging client build variables before building. Mobile
  needs `VITE_CONVEX_SITE_URL`, `VITE_CONVEX_DEPLOY_URL`, and `VITE_SERVER_URL`; use
  matching site and direct push settings from the same environment. Set `VITE_SITE_URL`
  to that environment's site as well: recovery files carry its origin, and an unset value
  means Lody Cloud (`https://lody.ai`), so staging files would not open on staging desktop
  or Web. An ignored
  `apps/mobile-capacitor/.env.staging.local` file supplies these for staging builds. A new
  checkout has no local `.env` file. A successful unconfigured Vite build can still
  fail at startup because Better Auth falls back to `capacitor://localhost`, which
  is not an HTTP authentication endpoint.
- Build and sync the staging web assets, then build the `App` scheme for an iOS
  Simulator. Simulator builds accept ad hoc signing with `CODE_SIGN_IDENTITY=-`
  and `CODE_SIGNING_ALLOWED=YES`; disabling signing omits entitlements and makes
  Keychain return `-34018`. App Store signing is a separate release step.
- On the iPhone Home Screen, touch and hold an empty area, choose Edit → Add Widget,
  search for Lody, and select **Conversation progress**, **Token usage**, or
  **Agent limits**. Verify both sizes, the
  signed-out empty state, and a tap back into Lody. Gallery conversations are
  synthetic preview data; quota gallery percentages are also examples. Authenticated refresh, account/workspace changes and expiry still
  require a configured session or real-device validation.

## Startup appearance

- The shell opens on the theme the user COMMITTED, not the system appearance.
  `src/startup-theme.ts` implements `window.__LODY_STARTUP_THEME__` (type in
  `@lody/components/theme-provider`) on the `LodyStartupTheme` plugin
  (`ios/App/App/LodyStartupTheme*.swift`, `android/.../LodyStartupTheme*.java`),
  which stores the value in the shell's own storage — the WebView's
  `localStorage` is unreadable at launch — and applies it live. On launch,
  `SceneDelegate` sets `window.overrideUserInterfaceStyle` BEFORE the bridge view
  loads (AppDelegate only covers the legacy window lifecycle): the Capacitor splash is instantiated from `LaunchScreen.storyboard`, so
  its `systemBackgroundColor` then resolves to the app's theme. `MainActivity`
  applies DayNight before `super.onCreate` and, on API 31+,
  `UiModeManager.setApplicationNightMode`, which is what makes the next
  launch's starting window match. Both paint the WebView background from it.
- The static iOS launch image shown during the icon zoom follows the system and
  cannot follow the app (drawn before any app code, snapshot-cached). Leave
  `LaunchScreen.storyboard` on `systemBackgroundColor`; the HIG wants it to
  look like the first screen, and after a storyboard change the device keeps
  serving the cached image until the app is deleted.
- The splash stays up until the renderer's theme class lands on `<html>`
  (`startup-theme-core.ts`), never on a timer and never on React's first commit,
  which can be the router still resolving. `launchShowDuration` is only the
  last-resort cap. Every boot-failure path must drop it itself — the inline
  guard in `index.html` uses the injected `Capacitor.Plugins.SplashScreen`
  because on a failed bundle nothing else can — or the failure UI is invisible.

## Selectable push provider

Android builds require the Firebase **client** `google-services.json` for
`ai.lody.android`, either at `android/app/google-services.json` (Git-ignored) or
in `PUSH_ANDROID_GOOGLE_SERVICES_JSON`. `configure:push` validates the package,
project, app ID and API key, rejecting missing/invalid files and Admin service
accounts before building. It never prints the configuration.

For CI, add `PUSH_ANDROID_GOOGLE_SERVICES_JSON` as a GitHub Environment secret
in `production` (Stable and Nightly) and in `staging` for staging builds, using
that environment's Firebase client configuration. All three Android publishers
(`release-cli.yml`, `publish-android.yml`, `nightly-electron.yml`) explicitly
pass the secret into the consuming build step and require it even on persistent
runners; a stale local file cannot substitute for a missing CI secret. Rebuild
the APK after changing this configuration; it is not a runtime backend setting.

Builds include both Capacitor PushNotifications and `onesignal-cordova-plugin`.
Set `VITE_ONESIGNAL_APP_ID` for fallback; the backend `PUSH_SELF_HOSTED_ENABLED`
flag selects the client registration provider at runtime. Re-run Capacitor sync
and install Pods after adding OneSignal; the iOS notification service extension
must be included in signed archives. Keep the 16.4 deployment floor and existing
Widget App Group. Verify notification clicks, foreground display, logout and
provider changes on real devices before release; JS tests do not cover SDK
notification-delegate coexistence. See the backend push guide for rollout order.

OneSignal uses the original `userId` and `activityId` without a version prefix.
This keeps existing clients reachable without re-registration. Clients that registered
with the retired prefixed identity must reopen an updated app to bind their subscription
to the original identity; offline clients are not migrated by a backend deployment.
Existing activities registered with a prefixed identity must end and be recreated by
the updated client before remote updates resume. Do not bulk-delete or merge provider
users during rollout. Account deletion cleans only the original user identity; no retired
version-prefixed registration, delivery, or cleanup path remains. This code change does
not delete existing provider identities.
OneSignal uses SDK-managed login/logout rather than the direct provider's server-side
session-expiry/revocation check; valid historical subscriptions may receive pushes again.

Mobile Vite builds use an 8 GiB Node old-space limit: the default 4 GiB limit can exhaust the heap while bundling the mobile renderer. The limit applies to the Vite build process, not Capacitor or Xcode.
