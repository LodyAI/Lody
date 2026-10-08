# Chromium transport for desktop authentication

Status: implemented
Translation: current

[中文](2026-10-08-desktop-auth-chromium-transport.zh.md)

## Abstract

A browser can complete authorization while the desktop's Node fetch fails to
exchange the code in a network requiring system proxy or certificate trust.
The desktop Better Auth client now uses Electron Chromium networking after app
readiness, preserving cookie hooks and cancellation. Certificate failures receive
localized clock, proxy/firewall and trust guidance instead of only requesting another
browser attempt. Synthetic behavior and an isolated Electron probe cover the client
boundary; actual hosted login and packaged OS trust/proxy acceptance remain separate.

## Decision and evidence

This extends the [login coordinator decision](../architecture/2026-09-17-desktop-login-coordinator.md)
and preserves the [Better Auth 1.6 baseline](2026-09-30-better-auth-1-6.md).
The current client defaults to Node's global fetch. CLI proxy environment handling
does not configure that main-process transport. Electron's
[net API](https://www.electronjs.org/docs/latest/api/net) supplies Chromium networking
and system proxy/PAC handling, and requires app readiness.
Chromium's [certificate verifier FAQ](https://chromium.googlesource.com/chromium/src/+/main/net/data/ssl/chrome_root_store/faq.md)
documents integration with explicitly configured local platform trust; it does not
promise identical default roots to every system browser.

`auth.ts` injects a narrow fetch adapter for all existing authentication-client
requests. The adapter waits for readiness, rejects an already-aborted request,
converts URL inputs to strings, and forwards Request/init/Response without rebuilding
the response. The current cross-domain plugin reads `set-better-auth-cookie`, stores
it through the existing auth storage, and sends `Better-Auth-Cookie` with credentials
omitted. Ordinary Set-Cookie visibility is also relevant to other cookie hooks.
No transport fallback, global dispatcher, certificate override or credential format
change is introduced. Local OSS composition continues to prohibit cloud authentication.

The coordinator classifies certificate failures only during exchange. It recognizes
Node TLS codes through a bounded cause chain and Chromium `net::ERR_CERT_*` messages,
retains bounded diagnostic details, and never retries a one-time code. The error is
named `exchange_certificate_failed` because certificate expiry and hostname mismatch
do not establish interception. The login page already projects the IPC category
through i18n; no extra renderer-owned exchange or presentation branch is needed.

Moving the CLI's undici dispatcher into main was rejected because proxy routing
alone does not supply Chromium's certificate verifier. Disabling certificate checks
would weaken the authentication boundary. Public clients cannot establish which
certificate a failing user's network presented, so the guidance does not diagnose
an attacker or promise that TUN fixes every certificate failure.

## Verification and limits

The existing callback suite covers readiness, URL/Request bodies and headers,
cookie persistence followed by an authenticated session read, cancellation before
readiness, deadline-driven transport abort, nested TLS and Chromium certificate
classification, replay rejection and reset on a fresh attempt. The login UI suite
covers the new guidance in both languages. All fixtures are synthetic; suite tests
use explicit deferred signals and fake timers without network access.

An isolated Electron 43.7.6 probe used synthetic HTTPS protocol responses to check
POST bodies, the cross-domain cookie header and AbortSignal rejection. A separate
loopback HTTP probe exercised the pinned Electron and cross-domain plugins together,
including encrypted-cookie storage through a temporary synthetic cipher and a
subsequent authenticated session read. Real HTTP responses expose ordinary Set-Cookie
as a combined header that the pinned parser accepts; custom-protocol responses
omit that header. Neither probe used a real account or hosted endpoint.
A synthetic self-signed loopback HTTPS probe was rejected by Electron with
`net::ERR_CERT_AUTHORITY_INVALID` and classified as `exchange_certificate_failed`,
confirming that the transport still rejects an untrusted certificate.

The callback suite passed 26 tests, the bilingual login UI suite passed 14, and
the complete Electron suite passed 211. `pnpm format` and `pnpm run docs check
--base origin/main` passed, with no registered SHA-protected topics.
`NODE_OPTIONS=--no-experimental-webstorage NODE_ENV=test pnpm check` passed.
Without that Node 26 environment setting, the unchanged boot-shell storage-failure
test failed because experimental Node Web Storage interfered with its jsdom storage
mock; the same unchanged suite passed all 19 tests with the setting. No boot-shell
source or test changes are part of this fix.

Packaged hosted login, system proxy/PAC behavior and platform certificate trust
require acceptance in the consuming cloud desktop. The public OSS build cannot
exercise authenticated hosted requests. The owning [Spec](../../../../specs/desktop-browser-login.md)
remains draft; implementation and checks do not constitute human approval.
