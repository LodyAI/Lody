# Confirm the account before handing a browser session to the desktop app

Status: implemented
Translation: current

[中文](2026-09-15-electron-browser-signin-account-choice.zh.md)

## Abstract

Signing out in the desktop app leaves the system browser signed in as the previous
account, and the browser page the desktop app then opens
(`/login?client_id=electron&state=…&code_challenge=…`) used that leftover session
on its own: it minted an authorization code for the account the user was trying to
leave and rendered nothing but a spinner, with no account choice, no retry, and no
way to reach the `lody://auth/callback` handoff if the automatic navigation did not
take effect. The page now names the signed-in account and hands nothing over until
the user picks "continue" or "use a different account", keeps this attempt's
`state`/`code_challenge` across that switch, discards a transfer that lands after
it, and renders the handoff URL as a real link next to the automatic attempt. This
was prompted by a report of the browser not opening the desktop app after an
account switch; it removes the dead end that report lands in, but it does not
establish why that browser did not open the app, and no browser's handling of the
automatic navigation was measured here.

## What the flow did, and what it does now

The desktop app's `requestAuth` opens the system browser at the web `/login` with
its PKCE `state` and `code_challenge`. A desktop sign-out clears only desktop state
([`signOutWithoutRedirect`](../../../../packages/components/src/lib/auth.ts) and the
main-process auth service); the browser's own session is untouched by design.

Previously, [`login-page.tsx`](../../../../packages/components/src/components/login-page.tsx)
reacted to any usable browser session by calling `electron.transferUser` from an
effect and replacing the location with `lody://auth/callback#token=…`. The server
mints that code for the session the browser currently holds, so after an account
switch the only reachable outcome was the old account. While that ran, the page
rendered a bare "Redirecting to desktop app" placeholder: the provider buttons were
unreachable, so a user could neither choose another account nor retry.

The page now renders a handoff panel in the ordinary login card:

- The signed-in account is shown, and no transfer starts without an explicit
  "continue with this account".
- "Use a different account" signs this browser out — the only way to hand the
  desktop app another account — and only on that explicit choice. The page does not
  navigate, so the URL keeps this attempt's `state`/`code_challenge`; the desktop
  app's pending code verifier still matches the next sign-in, whose OAuth callback
  already carries the same query through `buildElectronWebLoginCallbackUrl`.
- The switch is not gated on the page's loading state: an in-flight transfer for the
  wrong account is exactly when that exit is needed. A generation counter bumped by
  the switch makes a transfer that resolves afterwards discard its code instead of
  producing a handoff, and the short-lived `better-auth.electron` cookie is cleared
  around each transfer so a stale code cannot be read back as this attempt's.
- Only a *confirmed* sign-out releases the handoff. `signOutWithoutRedirect` used to
  swallow both failure shapes — Better Auth throws on transport failures and reports
  API failures in `response.error` — so a failed sign-out was indistinguishable from
  a successful one while this browser's cookie, the very thing a transfer hands over,
  still authenticated the previous account. It now returns a `SignOutOutcome`, and a
  failed switch says so and blocks the transfer until a retry succeeds.
- Once a code exists, the `lody://auth/callback#token=…` URL is built once and used
  both by the automatic navigation and by a visible link. The navigation moved into
  an effect so the link is painted before the attempt: a browser that declines a
  custom-scheme navigation reports nothing back, so the link has to already exist.
- Errors stay on this panel, reusing the existing message state, so "continue" is
  also the retry entry point. The existing `expired=1` prompt is untouched.

## Alternatives and limits of this change

Keeping the automatic transfer and adding only a fallback link was rejected: it
leaves the account choice unreachable, which is the reported dead end. The cost is
one extra click on the happy path, including right after an OAuth round trip.

A manual "paste the authorization code into the desktop app" fallback was
considered and not built. It would have to carry the `identifier` + `state` payload
through the desktop app's existing PKCE exchange and callback transaction rather
than accepting a session token, which is a larger surface than the visible link
needs while the link exists.

Nothing here touches macOS protocol registration, LaunchServices, or browser
settings, and the OSS `lody-oss` scheme versus the cloud build's `lody` scheme is
an intended build difference, not part of this defect.

## Verification and limits

- [`tests/electron-browser-login-handoff.test.tsx`](../../../../packages/components/tests/electron-browser-login-handoff.test.tsx)
  renders the real `LoginPage` in jsdom against a stubbed auth client and covers:
  no transfer without a choice; the link's decoded `identifier`/`state` payload
  matching the URL the page navigates to; a late transfer after a switch producing
  no link and no navigation; the `state`/`code_challenge` surviving the switch into
  the next provider sign-in; and a failed transfer leaving an enabled retry.
- That suite found the switch button disabled while a transfer was in flight, which
  is the state the escape hatch exists for; the gate was removed.
- The failed-sign-out cases (a rejected request and an `error` response) assert the
  blocked handoff and its release on a successful retry. Restoring the old
  swallow-the-failure behavior in `signOutWithoutRedirect` makes exactly those three
  cases fail, so the guard is load-bearing rather than decorative.
- jsdom cannot navigate a custom scheme and `window.location.replace` is
  unforgeable, so the test replaces exactly one navigation primitive and asserts the
  URL handed to it equals the rendered link's `href`.
- Whether any particular browser performs the automatic `lody://` navigation is not
  determined by this change or its tests, and the original report's cause on the
  user's machine remains unestablished.
- The Storybook state covers the account-choice panel only; a story must not fire a
  protocol handoff at a reader, so the post-transfer state is covered by the test.
- No packaged desktop app was built or run; the desktop side of the exchange is
  unchanged.
