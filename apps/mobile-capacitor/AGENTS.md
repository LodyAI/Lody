# Mobile App Agent Guidelines

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Root `AGENTS.md` also applies.

## Minimum iOS compatibility

- Minimum: **iOS / iPadOS 16.4 (WKWebView)**, matching Tailwind 4, including
  shared code and Workers. Guard or polyfill newer APIs, syntax and CSS.
- Keep Podfile, Xcode targets and Vite Safari target at 16.4.
  [Audit and device checks](BUILDING.md#build-compatibility).
- Newer APIs need an early, tested polyfill or capability-gated fallback.
  Main-thread polyfills exclude Workers. Vite's JS target does not polyfill
  Web APIs, CSS or runtime-generated regular expressions; inspect dependencies too.
- `src/polyfills.ts` runs before app imports and is injected into every bundled
  Worker by `vite-worker-polyfills.ts`. Worker code must use `?worker` /
  `?worker&url`, never raw `?url`. `vite-diff-css-compat.ts` compiles Pierre's
  JS-embedded shadow-root styles too; ordinary CSS transforms cannot see them.
- Retain composed abort signals through body consumption; PDF event signals use
  `pdfAbortSignalAny` until owner teardown. Before new Request/event consumers,
  read the guide above: native following signals alone can lose cancellation.
- Keep `build.cssMinify: 'lightningcss'` alongside `cssTarget`: Vite skips
  CSS lowering when JS `minify: false` also disables the default CSS minifier.
  Check emitted CSS and preserve controls, layout, layers and theme contrast.
- Guard newer native features; absence must not block core use or push.

## Keyboard handling (the core invariant)

- iOS: Keyboard `resize: none` + `interactive-widget=overlaps-content` preserve
  WebView height. `LodyBridgeViewController` publishes the current window's keyboard
  layout guide as `--native-keyboard-height`; `src/native-keyboard.ts` handles older
  shells without its document-start marker.
- Android: `resizeOnFullScreen` resizes WebView; CSS offset stays `0px`.
- Web: browser resizes the viewport; CSS offset stays `0px`.

Shared `workspace-layout-utils.ts` applies the root offset. Child surfaces use
only `var(--safe-area-bottom)`; never offset twice. Portal sheets/session drawers
must lift themselves. Follow [keyboard ownership](AGENTS.md#keyboard-handling-the-core-invariant)
for safe-area collapse, focus scrolling and platform-scoped vaul positioning.

## Layout composition

- iOS applies left/right safe areas independently to the native WebView container,
  including portals. Top/bottom remain web-owned. Recompute from view bounds;
  never choose layout by model/screen size. [Duo note](notes/2026-10-27-iphone-duo.md).
- Side rail needs the system vertical-bar trait, reserved regions and keyboard
  geometry; confirm visibility before hiding web controls; fall back on old SDKs.
- `main-layout.tsx` selects phone/wide layouts with `useIsMobile()`. Both share
  `LoroAppSidebar`; mobile wraps it in `MobileSidebarDrawer` and uses dedicated
  `MobileHomeScreen` / `MobileWorkspaceStack` surfaces. Read
  [workspace/sidebar hotspots](README.md).

## Telemetry

The WebView must use the shared workspace replay/exception guard after its separate adoption. Pre-React beacons
use fixed error types, never mutable Error names; preserve full local diagnostics.
See [composition and adoption](../../packages/platform/AGENTS.md#telemetry-privacy).

## App launch policy

- iOS 27 SDK requires the scene manifest and `SceneDelegate.swift`. Keep one
  storyboard-owned `LodyBridgeViewController`. Capacitor 8.2 needs custom URLs
  forwarded through `ApplicationDelegateProxy` after root-view/plugin loading.
  Do not duplicate UIKit's application lifecycle notifications.

- Ordinary Lody HTTP(S) links stay in the browser. Do not add `applinks` Associated Domains,
  Android HTTP(S) VIEW filters, or native startup routing for website URLs.
- Safari's app-id-only Smart App Banner is the explicit website-to-iOS-app entry.
- Keep OAuth's `lody://` custom scheme and native push `data.route` navigation
  separate from browser links. See
  [context/mobile-app-launch.md](AGENTS.md#app-launch-policy) for ownership
  and rollout invariants.

## Startup appearance

- The shell opens with the committed theme; splash drops when it reaches
  `<html>`. Boot failures dismiss it.
  Read [startup appearance](BUILDING.md#startup-appearance) before editing
  native theme storage, launch screens, scene startup or splash handoff.
- `src/main.tsx` awaits `initI18n` before `createRoot`, as Electron does: a
  component rendered before react-i18next has its instance skips its hooks and
  crashes on its next render, including the ErrorBoundary fallback.

## Blank screen recovery

Keep separate owners for a live empty DOM and WebKit process loss. Never reload
mounted-but-stuck React or change the document title. Follow the
[recovery boundaries](README.md#blank-screen-recovery-two-layers-do-not-merge-them)
before changing either owner.

## Full native reset

`src/index.html` installs `__LODY_NATIVE_RESET__` before the bundle and adds boot
reset actions. iOS `LodyNativeResetPlugin` owns verified WebKit deletion, scoped
credential removal and diagnostic ID preservation. Never delete files under a
live WebView. Contract and device checks: [native-reset.md](native-reset.md).

## E2EE custody

`CAPPlugin` follows the `CAPBridge` lifetime; a WebView soft reload does not trigger plugin `deinit`.

`LodyKek`: scoped KEK operations only; never export KEKs or enable bridge logs.
Keep calls owned until actual settlement. [iOS](e2ee-custody.md) / [Android](e2ee-android-custody.md).
The [native custody adapter](e2ee-native-adapter.md) retains wrapping originals;
its installation checks must never reconstruct a lost KEK over residual records.

## Billing UI

- Until native billing exists, mobile and native-shell surfaces must not expose
  billing settings, checkout, paid-workspace creation, plan badges or upgrades.
  Limit states may explain blocked creation or sending without a billing destination.
  Keep Web/Electron billing flows intact.

## Native assets

App icon catalogs and Live Activity marks: [BUILDING.md](BUILDING.md#ios-app-icons).
Read those invariants before editing their Swift or image assets.

## Home Screen widgets

Live Activity summaries and widget publication require a matching, explicitly plaintext
runtime; other states clear existing native snapshots; decrypted workspace content never enters ActivityKit
or App Group storage.

Require matched auth/runtime/workspace; latch logout per page. Token queries use
identity; metadata reads require readiness. Pending may retain only decoded
same-owner snapshots without renewing age. Join raw writes; drain clears/retries
before disposal. Reset clears caches; expiry stays 15m (usage: source end).
[Ownership/recovery contract](notes/2026-10-31-widget-cache-recovery.md).

## App Store review prompt

- `src/app-store-review.ts` only bridges the shared prompt hook to
  `ios/App/App/LodyAppStoreReviewPlugin.swift`; it calls StoreKit only and cannot observe
  whether the sheet was shown or what rating was selected.
- `packages/components/src/hooks/use-app-store-review-prompt.ts` owns the
  device-local eligibility state and consumes opaque finalized-turn outcomes. Keep this
  per-turn data out of Flock metadata.

## Push notifications

- The authenticated client reads the backend provider flag. OneSignal is the default;
  preserve its Cordova plugin, iOS service extension and SDK logout at native reset.
  Self-hosted mode explicitly opts in and uses the Capacitor bridge.
- `src/push-notifications.ts` owns the Capacitor PushNotifications bridge;
  shared `packages/components/src/lib/push-notifications.ts` owns settings
  and subscription lifecycle. Native paths never use browser permission APIs.
- OneSignal login and ActivityKit use original user/activity IDs, matching existing clients.
  Retired prefixed registrations require the updated client to reopen; existing prefixed
  activities must end and be recreated before remote updates resume. Account deletion
  cleans only original user IDs; retired version-prefixed cleanup is removed.
- Direct APNs/FCM/Web Push configuration and test commands:
  [PUSH_NOTIFICATIONS.md](BUILDING.md).
- iOS registration reports the actual Bundle ID through `App.getInfo()`; the
  backend selects an allowlisted app configuration.
- ActivityKit token uploads must wait for authenticated installation registration;
  optional activity setup must never disable ordinary push. Preserve the existing
  Widget App Group even though its historical identifier contains `onesignal`.
- Android client Firebase config is generated from `PUSH_ANDROID_GOOGLE_SERVICES_JSON`
  or an ignored `google-services.json`; `configure:push` must reject missing or invalid
  client configuration before native builds. Every Android CI publisher explicitly passes
  and requires the selected Environment secret; server service-account keys never enter builds.
- Current Live Activity summaries are silent; keep legacy alert inputs readable.
  The native manager checks its in-memory revision after awaited stale-activity
  cleanup: a newer sync/end must prevent an older sync from creating an activity.
  This is a process-local creation fence, not remote delivery ordering or replay.

## Builds and releases

Read [BUILDING.md](BUILDING.md) before changing native build commands, icons,
versioning or Vite build compatibility. Nightly retains the production native app
identifiers and backend, so Android version codes must be comparable with Stable.

The native encrypted-workspace entry and its acceptance boundary are documented in
[e2ee-runtime.md](e2ee-runtime.md).
