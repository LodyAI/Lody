# Native iOS sign-in

The UIKit sign-in form calls `AuthSession`, the only owner allowed to install a
Better Auth session in Keychain. It validates the account before installation,
drains previous local persistence before admitting a replacement attempt, and
checks cancellation after every suspension before credential installation.
Passwords are cleared from the form after submission and are never persisted.

## Sign-in page

`OnboardingController` reproduces web `/login` (`packages/components/src/components/login-page.tsx`)
in UIKit: full screen on iPhone (a form sheet on iPad), the dithered jellyfish surface on top
(`LoginDitherView`, web's WebGL fragment shader ported line for line to a Metal source compiled at
runtime, ~1.5 pt cells snapped to whole device pixels, 1.6 s centre-out reveal, one still frame under Reduce Motion), then a
bottom-anchored column: title and description, one group of equal GitHub / Google / Apple / Discord
buttons, the "Continue with email" row, and the legal notice. The method this device last completed
(`NativeLastLoginMethod`, written by `AuthSession` after a credential is installed) carries the
"Last used" badge. The email view slides in beside the providers and folds the visual away; it
holds web's sign-in / create-account form (create account applies web's letters-and-digits,
8-character rule), and a sent verification link (`AuthSnapshot.verificationSent`) replaces the form
with web's "Next steps" panel. Colours are web's product palette (`LoginPalette`); controls keep
44 pt touch targets where web uses 36 px buttons. Provider marks live in `App/Icons.xcassets`.

## Public protocol

- Email: `POST https://backend.lody.ai/api/auth/sign-in/email` with
  `{email, password, callbackURL: "https://backend.lody.ai/api/auth/mobile/email-verified"}`.
- Registration: native name/email/password posts `/api/auth/sign-up/email` with
  the same verification callback. A returned session uses the normal validated
  account-install path. A successful `token: null` response explicitly triggers
  `/api/auth/send-verification-email` because backend `sendOnSignUp` is false.
  Native resend uses that endpoint and callback without installing a session.
- Apple: AuthenticationServices requests a fresh SHA-256 nonce and exchanges the
  signed ID token at `/api/auth/sign-in/social` with
  `{provider: "apple", idToken: {token, nonce}}` (the original nonce). First-consent given/family names are included as optional
  `idToken.user.name.{firstName,lastName}`; later consent may omit them.
- Google: GoogleSignIn-iOS 9.0.0 obtains an ID token and sends the same standard
  Better Auth request with `provider: "google"`. SDK account state is signed out
  after token extraction; it does not own the Lody session.
- GitHub and Discord: `ASWebAuthenticationSession` opens
  `/api/auth/mobile/start?provider=...&redirect_uri=lody%3A%2F%2Fauth%2Fmobile-callback&state=...&code_challenge=...&code_challenge_method=S256`.
  State and verifier each have 32 random bytes. The exact callback is
  `lody://auth/mobile-callback?code=...&state=...`; duplicate parameters, foreign
  destinations, fragments, errors and mismatched states fail closed. The native
  client exchanges the opaque code once at `/api/auth/mobile/exchange` with
  `{code, code_verifier, redirect_uri}`. A lost response requires a fresh sign-in,
  not automatic replay. The backend code lifetime is 60 seconds.

Credential HTTP uses an ephemeral, cookie-free URLSession with a 30-second
request timeout and rejects all redirects. Only the response body's raw `token` is accepted as a session credential;
missing or invalid raw tokens are rejected even if `set-auth-token` is present.
That header contains a signed cookie value, which Better Auth accepts but Lody's
Streams authorization does not. No session token enters a browser URL,
logs, the clipboard, or the protocol WebView. Provider pages may appear in the
system authentication session; there is no Lody Web login page or device code.

## Password reset

The native email request form posts `/api/auth/request-password-reset` with
`{email, redirectTo: "https://lody.ai/reset-password"}`. Password reset completes
on the standard HTTPS website, not a Web login screen. The app does not receive,
parse or retain reset capabilities, and does not create a session from reset
links. Raw reset tokens must never be delivered through a hijackable custom
scheme. OAuth continues to use one-time codes protected by native PKCE.
Deployed HTTPS reset-page behavior and emailed-link delivery remain unverified.

## External configuration

`project.yml` sets these **public** Xcode build settings on the Lody target to
production's Google clients (never client secrets):

| Setting                          | Value                                                    |
| -------------------------------- | -------------------------------------------------------- |
| `LODY_GOOGLE_IOS_CLIENT_ID`      | Google OAuth iOS client ID for `ai.lody.mobile`          |
| `LODY_GOOGLE_SERVER_CLIENT_ID`   | Google web/server client ID accepted by Better Auth      |
| `LODY_GOOGLE_REVERSED_CLIENT_ID` | Reversed iOS client ID used as the registered URL scheme |

The plist maps these to `GIDClientID`, `GIDServerClientID` and URL schemes.
Missing IDs or a missing reversed callback scheme produce a localized
configuration error instead of launching the SDK. A build for other Google clients
overrides all three on the `xcodebuild` command line; changing the defaults requires
`pnpm prebuild` to regenerate the project.

Enable Sign in with Apple for the app's developer-team identifier and refresh
provisioning profiles; `App/Lody.entitlements` declares the capability. Configure
the backend to accept the native bundle audience and the Google server audience.
Reuse the backend's existing `/api/auth/callback/github` and `/discord`
registrations and provider credentials; no separate native OAuth app or provider
callback is needed. Deploy the matching native handoff backend before shipping. No provider secret or Apple signing key belongs in this directory.

## Verification and limits

Run from this independent iOS workspace:

```sh
pnpm verify:native --case auth
pnpm verify:native --case auth-session
pnpm check
pnpm bundle
pnpm prebuild
pnpm verify:build
```

`auth` runs production HTTP/protocol logic on the macOS host with synthetic
transport responses: standard email/ID-token payloads, raw-token selection and header-only credential rejection,
error rejection, S256 and strict callback validation. `auth-session` compiles the
production session owner and UIKit login form for the iOS simulator, with
scripted storage/Keychain/provider boundaries. It cancels exactly during clear
and save, asserts no stale credential, then verifies a later login/logout and
secure form submission. Reset coverage checks the request uses HTTPS completion. Neither test claims real provider acceptance.

The offline `onboarding` UI case uses production controls and a deterministic
service. Full screenshot verification requires a successfully built app. Real
Apple/Google consent, signed ID-token verification, deployed GitHub/Discord
callbacks, email verification policy and custom-link delivery require configured
providers and an authorized test account.

Offline validation covers the signed simulator app and the production onboarding
Debug scene in English, light and dark: provider order and touch targets,
email/create-account switching, cancellation, error recovery and account-owned
completion. The provider visual yields from its preferred height toward 200 pt
before the column scrolls, keeping legal copy visible without reducing 44 pt
controls. UI checks assert legal visibility and capture email/create-account
resting states after native keyboard dismissal. Screenshots and recordings exercise the runtime-compiled Metal dither
and its entrance reveal; native session checks cover credential installation.
These checks do not establish real-provider acceptance. The license inventory
check includes the resolved SDK dependencies. `pnpm check` validates TypeScript,
contracts, localization, native sources, licenses and repository formatting.

Password reset is supported only when `CONVEX_SITE_URL` is exactly the canonical
production origin `https://backend.lody.ai`. Other auth/site origins are rejected
before any network request, with a localized unsupported-local-reset message; no
reset email is requested. Production keeps the existing HTTPS web reset flow.
There is no additional reset URL configuration.
