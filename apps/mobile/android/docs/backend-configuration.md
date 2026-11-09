# Android build-time backend configuration

Gradle reads `../.env.local` relative to the Android project root — that is,
`apps/mobile/.env.local`, shared with iOS. The existing mobile `.gitignore`
ignores this file. Do not put credentials in it: these origins enter BuildConfig
and are public in the APK. No file is required for production builds.

| Key               | Example override             |
| ----------------- | ---------------------------- |
| `CONVEX_URL`      | `https://rpc.example.com`    |
| `CONVEX_SITE_URL` | `https://auth.example.com`   |
| `CF_WORKER_URL`   | `https://worker.example.com` |

Android invokes the existing shared `../backend-config.mjs` resolver. Process
environment keys override file values; missing or empty values currently select
production defaults. The resolver owns parsing, URL validation and storage suffixes;
Android does not maintain a second parser. Shared resolver docs/tests are maintained
at the mobile level.

All variants require HTTPS. The main manifest forbids cleartext and debug does not
override it. No certificate or hostname validation bypass is installed.

For local-stack, select the **public client-facing TLS origins**, not the backend's
internal environment. In particular, mobile `CONVEX_SITE_URL` must point at the
public HTTPS site (the stack's `BETTER_AUTH_BASE_URL`), not the backend-generated
HTTP `CONVEX_SITE_URL` used for OIDC/JWKS self-access. Convex cloud and Worker must
also use their public TLS origins. Obtain the actual selected run's URLs rather
than copying internal service variables. Android device routing and trust of that
run's CA require separate setup; desktop SPKI/Node CA settings do not configure
Android. Do not disable TLS verification to make the local stack connect.

Native auth, verification callbacks, Convex brokerage/RPC and uploads use these
origins. Third-party GitHub URLs, the bundled WebView asset origin, public avatar
HTTPS policy and the web password-reset destination are not backend overrides.
Streams still use separately validated server-issued grants, not these origins.

The shared resolver selects a SHA-256-derived storage suffix for the canonical
three-origin tuple. Production
keeps the existing empty suffix: credentials, Keystore aliases, pending browser
PKCE state, account/catalog caches and tab navigation data are not deleted or
migrated. Nonproduction tuples have separate namespaces, including avatar disk
cache; switching back restores production data. Logout only clears the active
namespace. UI-only preferences are intentionally shared.

Verification:

```sh
./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintDebug
```

Native JVM tests cover credential audiences using the configured endpoints. Shared
resolver tests own defaults, override precedence, origin rejection and storage
identity. These checks do not claim device login or local Streams acceptance.

Password reset is supported only when `CONVEX_SITE_URL` is exactly the canonical
production origin `https://backend.lody.ai`. Other auth/site origins are rejected
before any network request, with a localized unsupported-local-reset message; no
reset email is requested. Production keeps the existing HTTPS web reset flow.
There is no additional reset URL configuration.
