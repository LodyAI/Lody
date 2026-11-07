# Android native authentication

Home renders localized native email/password and registration fields. Passwords
are memory-only Compose state, never saved in a Bundle. Better Auth endpoints on
`https://backend.lody.ai` handle `/api/auth/sign-in/email`, `/sign-up/email`,
`/send-verification-email` and `/request-password-reset`. Registration without a
session explicitly sends a verification email (the server does not send on sign-up).
Verification emails use `https://backend.lody.ai/api/auth/mobile/email-verified`,
a harmless backend result page that never authorizes the app. Sign-up, sign-in
and resend requests all provide this callback URL. Password reset is requested
natively with `redirectTo: https://lody.ai/reset-password` and completed on that
existing HTTPS page. Return to native sign-in after completion; there is no Web
login or automatic native session.

Reset tokens are bearer capabilities without PKCE protection. A custom-scheme
handler can be claimed by another app, so **no reset capability may be delivered
to a custom scheme**. Android has no reset callback, reset-token storage or native
completion endpoint. This auxiliary HTTPS reset page is intentional and distinct
from the prohibited Web login flow. OAuth callbacks remain safe to redeem only
with the locally held PKCE verifier; that contract is unchanged.

Errors are mapped to English/Simplified Chinese resources; raw server messages
are never displayed or logged.

## Sign-in page

`auth/NativeSignInScreen` reproduces web `/login` (`packages/components/src/components/login-page.tsx`)
and stays in step with iOS `OnboardingController`: the dithered jellyfish surface on top
(`auth/LoginDitherView`, web's WebGL fragment shader unchanged on OpenGL ES 2, drawn into a
framebuffer of 3 dp cells and magnified without filtering; the blit pass paints the rounded corners
and the fold-away fade because a SurfaceView ignores Compose clipping; the full output buffer is
cleared to the page colour before each blit to cover viewport lag during resizing; one still frame when system
animations are off), then a bottom-anchored column: title and description, one group of equal
GitHub / Google / Apple / Discord buttons, "Continue with email", and the legal notice. The method
that last installed an account (`LastLoginMethod`, SharedPreferences) carries "Last used". The
email view slides in beside the providers, clipped to the form column so outgoing controls cannot
paint over the page margins, and folds the visual away; it holds web's sign-in /
create-account form (`LoginForm`, `LoginFormTest`: create account applies web's letters-and-digits,
8-character rule), and a sent verification link shows web's "Next steps" panel. Colours and
geometry are `designsystem/LodyLoginColors.kt`; controls keep 44 dp touch targets where web uses
36 px buttons.

## Provider setup (public IDs only in the app)

- Google uses AndroidX Credential Manager with the official Google ID library,
  `GetSignInWithGoogleOption`, and a per-attempt nonce. Supply the **Web OAuth client
  ID** via `-PLODY_GOOGLE_WEB_CLIENT_ID=…apps.googleusercontent.com` or a local
  Gradle user property. No placeholder ID or secret is bundled. Without the ID,
  the Google action reports that this build is not configured.
- In Google Cloud, register Android OAuth clients for application ID
  `ai.lody.android` and each permitted signing-certificate SHA fingerprint. The
  optional `.m3e` application ID needs its own registration. The Web client ID must
  be accepted by the backend Google provider. Enable Google Play services on the
  device. Never put the Web client **secret** in Gradle or the APK.
- GitHub, Discord and Apple Android open provider OAuth in Custom Tabs, **not** a
  Lody Web login page. Reuse the existing provider credentials and HTTPS return URLs
  `https://backend.lody.ai/api/auth/callback/{provider}`; no additional provider
  callback or separate native GitHub OAuth app is required. Apple needs
  its Services ID, server-owned signing credential, and POST callback support.
  Those credentials belong only on the backend. Deploy the native handoff routes
  before enabling production acceptance; building the app cannot configure providers.
- Android's manifest registers exactly `lody://auth/mobile-callback`. PKCE binds
  redemption to this installation even if another app registers the same scheme.
  Do not run two app variants concurrently for real provider acceptance without
  choosing the intended callback handler.

## Handoff and ownership

`AccountController` owns every login, restore, cancel and logout. Before Custom
Tabs opens, it creates independent 32-byte random state and verifier, saves them
with a ten-minute timestamp in `browser-auth.enc` under `noBackupFilesDir`, and
uses a separate Keystore AES-GCM alias from the account credential. Process death
before callback therefore retains the attempt; no Activity owns its authority.

The start URL is `/api/auth/mobile/start` with `provider`, `redirect_uri`, `state`,
`code_challenge=BASE64URL(SHA256(verifier))`, `code_challenge_method=S256`. The
callback accepts only exact scheme/authority/path with one state and one 43-character
base64url code, or one recognized error. Duplicate parameters, encoded aliases,
userinfo, ports, fragments, extra paths and token-bearing URLs are rejected.
State mismatch cannot cancel a newer login. Pending state is consumed before
native POST `/api/auth/mobile/exchange` with `code`, `code_verifier`, `redirect_uri`.
Only the HTTPS response returns a native session token; it never enters a URL,
Intent extras, UI state or WebView. Lost exchanges are not retried: sign in again.
The backend independently expires and atomically consumes the handoff.

The callback Activity clears its input Intent and delegates to application-owned
work. Activity destruction does not cancel an accepted exchange; configuration changes retain only its completion Job, never its callback URL. Native Google
credential UI, in contrast, is cancelled when its owning Activity is disposed.
Logout/cancel/new login invalidate the owner epoch and clear pending authorization;
a late uncooperative SDK/network response cannot save credentials or publish login.

Account verification still precedes credential persistence. Existing account
ciphertext, Keystore alias, cached-unverified display, workspace scope checks and
short-lived-only runtime grants are unchanged. No device-code client remains.

## Verification and remaining acceptance

JVM tests exercise native request bodies, safe error mapping, verification-required
registration, PKCE state recovery, one-shot consumption, exact callback rejection,
expiry, replacement/cancellation and late exchange fencing. Reset coverage checks the fixed HTTPS redirect and rejection of reset links by the OAuth callback parser. Existing account cache,
revocation and grant-scope tests remain. Run:

```sh
./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintDebug
```

Real provider consent, external configuration, email delivery, Credential Manager
UI, Custom Tabs return and OS process-kill recovery require a configured backend
and a dedicated test device. Do not treat compilation or offline tests as evidence
that those external flows have succeeded. Do not clear or reinstall over the user's
signed-in preview device to test them.

Password reset is supported only when `CONVEX_SITE_URL` is exactly the canonical
production origin `https://backend.lody.ai`. Other auth/site origins are rejected
before any network request, with a localized unsupported-local-reset message; no
reset email is requested. Production keeps the existing HTTPS web reset flow.
There is no additional reset URL configuration.
