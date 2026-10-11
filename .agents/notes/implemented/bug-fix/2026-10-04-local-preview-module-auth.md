# Local preview module authentication

Status: implemented
Translation: current

[中文](2026-10-04-local-preview-module-auth.zh.md)

## Abstract

Local previews issued SameSite=Lax capability cookies, which Chromium rejected
inside cross-site frames. First-level resources could authenticate with a
token-bearing Referer, while nested imports lost the token and returned 403.
The proxy now issues Secure, HttpOnly, SameSite=None, Partitioned cookies for
local viewing as well as remote viewing, and gives each local endpoint a distinct
cookie name so concurrent Sessions cannot overwrite one another. Synthetic
Chromium HTTP and file-host checks pass; the reported page's separate 502 and
unrelated console warnings remain unverified.

## Decision and evidence

Cookie scope ignores ports. All ephemeral local listeners used the same host,
path and name, so even a context accepting the cookie could replace one Session's
token with another's. Local names now include the endpoint ID; remote names stay
unchanged because remote viewers have distinct bound hostnames. Authorization
still checks the exact active endpoint's token on every HTTP request and WebSocket
upgrade. Bare Origin and tokenless Referer remain insufficient, and forwarding
continues to strip all cookies before contacting the target.

A real Chrome fixture embedded `127.0.0.1` under a `localhost` top-level page.
With SameSite=Lax, no cookie was stored or sent on the entry or nested module.
With Secure, SameSite=None and Partitioned, Chromium accepted the loopback cookie
and sent it on both. This uses Chromium's trusted-loopback handling; it does not
make arbitrary HTTP origins secure or promise compatibility with every engine.
[Chrome's partitioned-cookie documentation](https://developer.chrome.com/docs/devtools/application/cookies)
explains the top-level-site partition key.

A second source-level check used the actual LocalPreviewProxyManager, a synthetic
module server, and a WebSocket echo server. For both a cross-site HTTP host and a
file host, it opened two Session frames sequentially, awaited module execution
and echo events, then fetched another resource from the first frame. Both frames
and the revisit succeeded; a request without credentials returned 403. No sleeps,
external services, user project files or captured transcripts were involved.

The existing proxy suite adds a shared cookie-jar regression, foreign-cookie and
anonymous rejection, upstream cookie stripping, and cookie-authenticated WS data
transfer. Cookie attributes are checked at the HTTP response boundary; Node fetch
does not itself model browser SameSite policy. The browser fixture was an ad hoc
source-level check, not a new CI browser dependency or packaged Electron test.

Validation: all 109 CLI preview tests, CLI typechecking, scoped lint and formatting
pass. Full `pnpm format` and workspace typechecking also pass. Root `pnpm check`
stops at existing `no-shadow` lint errors in `mobile-account-settings.tsx` and
`unified-project-selector.tsx`, before repository tests. Documentation checking
reports six unrelated links into uninitialized Kimi and Pi submodules; no changed
document is reported as invalid. A packaged application build was not run.

## Scope and related decisions

This repairs credential delivery without relaxing the
[Quick Tunnel access contract](../../../../specs/quick-tunnel-preview.md).
The earlier [Fetch Metadata fix](2026-09-20-preview-fetch-metadata.md) addresses
upstream Astro rejection of navigation metadata and remains necessary; it does
not solve cookie loss in nested imports. Origin mapping, local target binding,
remote cookie naming and credential separation remain intact.

A 502 can be an upstream failure or a proxy exception; its response body is needed
to distinguish causes. The reported 502, 404 and styleq warning were not reproduced
by these authentication fixtures and are not claimed fixed. Running user desktop
and daemon processes were not replaced.
