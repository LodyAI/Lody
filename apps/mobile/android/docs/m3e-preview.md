# Material 3 Expressive integration

The Android production app now uses the reviewed M3E component direction. The
constraint is strict: preserve layout, order, spacing, typography, palette and
interaction entry points. Do not redesign screens during component replacement.

## Production mapping

- `LodyTheme` uses `MaterialExpressiveTheme` and `MotionScheme.expressive` for all
  screens, dialogs, dropdown menus, sheets, switches and existing Material controls.
  Lody color, typography and shape tokens are passed explicitly.
- `LodyControls.kt` supplies native shape-morphing Button, TextButton, IconButton and
  FilledIconButton wrappers. It retains the previous content padding and occupied
  sizes instead of adopting the new expressive size presets.
- All production Material button call sites use those wrappers: home/search/project
  sheets, creation, conversation, message actions, task navigation and dialogs.
- Custom sign-in, send/stop, new-chat and PR action buttons use the native controls
  in their original containers. Indeterminate progress uses native LoadingIndicator
  in the old bounds. Worktree selection uses a native Checkbox with one toggle target.
- Run configuration still has label/value rows with options expanding in place.
  The floating home bar, transcript, context capsules, custom disclosure rows and
  composer keep their existing layout. Foundation text editing, long-press actions,
  status glyphs and product-specific content remain purpose-built; M3E does not
  provide equivalent replacements that preserve those contracts.
- No NavigationBar/extended FAB, card regrouping, horizontal reasoning buttons,
  extra Done button, or permanently expanded composer is introduced.

The version catalogs pin Material3 `1.5.0-alpha23` for production, matching the reviewed preview APIs. This is an explicit exception
to the general stable-dependency preference for the requested M3E migration. Other
Compose dependencies remain on their existing BOM. Keep future upgrades deliberate.

## Verification

- Debug, Release and offline M3E variant builds; Android lint; JVM tests.
- Device tests: global expressive motion with unchanged light/dark tokens, control
  bounds, message actions, transcript/viewport scrolling and creation loading.
- Production creation page before/after screenshots and run configuration expanded /
  collapsed states on the dedicated emulator. Capture fresh evidence locally; historical review artifacts are not included.

## Offline review app

The existing `m3e` variant is an offline review utility, with a plain Application,
local fixtures and a separate `ai.lody.android.m3e` package. It does not send messages
or modify PRs. Its run configuration, composer and bottom bar reuse production
components; other fixture content is illustrative, not a proposed page redesign.

From `android/`:

```
./gradlew :app:assembleM3e
adb -s <preview-device> install -r app/build/outputs/apk/m3e/app-m3e.apk
adb -s <preview-device> shell am start -n ai.lody.android.m3e/app.lody.android.diagnostics.ExpressivePreviewActivity
```

Optional launch extras: `--es screen home|chat|config`, `--ez dark true`.

Sources:
- https://m3.material.io/blog/building-with-m3-expressive
- https://developer.android.com/jetpack/androidx/releases/compose-material3
- Official AndroidX source JAR for Material3 1.5.0-alpha23 from Google Maven.
