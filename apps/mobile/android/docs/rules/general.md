# General rules (Android)

Read before any change under `apps/mobile/android`. These rules bind every caller of the area, not only files in its directory.

- Independent Android-only client. Use Kotlin and Gradle Kotlin DSL; open the root in Android Studio.

- The iOS repository is a reference for behavior and public cloud protocol only. Do not import its build, private packages, credentials, or absolute source paths.

- UI decision: use Jetpack Compose + Foundation, with Material 3 components where appropriate. Keep product components and design tokens separate from screens. iOS and Android share design semantics and component responsibilities, but keep platform-native navigation, keyboard, accessibility and lifecycle behavior. No extra UI component library by default.

- Use stable dependency versions, pinned in `gradle/libs.versions.toml`; AGP owns built-in Kotlin support. AGP 9 ships Kotlin 2.2, so the root `buildscript` puts the catalog's newer Kotlin Gradle plugin (2.4) on the classpath; the Compose compiler plugin follows the same `kotlin` version.

- Preserve user edits. Never copy tokens or signing keys into the repository. Keep local SDK paths in ignored `local.properties`.

- Follow native Android navigation, lifecycle, accessibility, and background execution rules.

- Verify scaffold changes with `./gradlew :app:assembleDebug :app:lintDebug`. Add behavioral tests when implementing behavior; do not report NO-SOURCE tasks as passing tests.

- Keep one app module and manual construction while these boundaries remain small. JSON belongs in adapters; do not introduce a second Streams client in native code or a dependency-injection framework for this probe.

- UI uses the shared mobile design system in `app/src/main/kotlin/app/lody/android/designsystem` (sources and font resources are owned by the app): `LodyTheme`, semantic tokens, Inter, Lucide `LodyIcons`. Do not hard-code colors, sizes or fonts in screens.

- Every user-visible string lives in `res/values/strings.xml` with a matching `res/values-b+zh+Hans/strings.xml` entry; keep both key sets identical.

- Dark app/page base and grouped backgrounds use soft black `#111113`, aligned with iOS, including launch/window surfaces. Never add an opaque pure-black background or pure-black mode; preserve translucent scrims/shadows and artwork.
