# Native iOS sign-in

The UIKit sign-in form calls `AuthSession`, the only owner allowed to install a
Better Auth session in Keychain. It validates the account before installation,
drains previous local persistence before admitting a replacement attempt, and
checks cancellation after every suspension before credential installation.
Passwords are cleared from the form after submission and are never persisted.

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

Supply these **public** Xcode build settings (never client secrets):

| Setting                          | Value                                                    |
| -------------------------------- | -------------------------------------------------------- |
| `LODY_GOOGLE_IOS_CLIENT_ID`      | Google OAuth iOS client ID for `ai.lody.mobile`          |
| `LODY_GOOGLE_SERVER_CLIENT_ID`   | Google web/server client ID accepted by Better Auth      |
| `LODY_GOOGLE_REVERSED_CLIENT_ID` | Reversed iOS client ID used as the registered URL scheme |

The plist maps these to `GIDClientID`, `GIDServerClientID` and URL schemes.
Missing IDs or a missing reversed callback scheme produce a localized
configuration error instead of launching the SDK. Set the build settings in the
app's build configuration or an operator-owned xcconfig; run `pnpm prebuild` to
regenerate the project after changing persistent app configuration.

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

Current verification: both native cases, bundle, prebuild, native source checks
and TypeScript/contract checks pass. `pnpm check` stops at existing hardcoded-copy
violations in `Shell/NativeDebug.swift` and `Sessions/ChatListView.swift`.
`pnpm format:check` reports existing drift in 11 unchanged protocol/tooling files.
The public repository's `pnpm run docs check` passes. Full app
build stops at GoogleSignIn-iOS SwiftPM clone access denial (HTTP 403 from the
workspace GitHub credential helper); it also reports a LodyDataChannel artifact
mapping error during failed resolution. Signing was not disabled. SDK compilation,
full-app screenshots and real-provider acceptance remain unverified. Once SDK
access is authorized, resolve its transitive dependencies and add their upstream
license notices to the existing native license inventory before distribution.

Password reset is supported only when `CONVEX_SITE_URL` is exactly the canonical
production origin `https://backend.lody.ai`. Other auth/site origins are rejected
before any network request, with a localized unsupported-local-reset message; no
reset email is requested. Production keeps the existing HTTPS web reset flow.
There is no additional reset URL configuration.
