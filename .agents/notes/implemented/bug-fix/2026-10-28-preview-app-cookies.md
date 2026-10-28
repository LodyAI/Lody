# Preview application cookies

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/2016

[中文](2026-10-28-preview-app-cookies.zh.md)

## Abstract

Application sessions need cookies for resources and WebSocket upgrades. The preview proxy scopes application cookie names to the local Session and target origin, or the remote endpoint, and forwards only that scope's application cookies, keeping its capability token out of the target. It forces partitioned cross-site attributes to work in an embedded viewer. This weakens SameSite CSRF protection and changes names visible to application scripts.

## Decision and alternatives

Local names use `lody_app_<scope>_<name>`, where scope is a truncated SHA-256 hash of the Session ID and target origin. Remote names use the endpoint ID. The proxy restores the original name on the way to the target. A local replacement reuses cookie names but generates a new capability value; different Sessions and target origins do not share names. The local HTTP parser accepts at most 1 MiB of headers, since cookies from other scopes share the same browser host and can exceed Node’s 16 KiB default before filtering. This is a bounded limit, not a guarantee against every possible cookie jar; distinct Sessions and origins can still accumulate cookies. It removes Domain and forces Secure, SameSite=None and Partitioned, retaining Path, expiry and HttpOnly. Browsers enforce the resulting scope and expiry. The [local capability decision](2026-10-04-local-preview-module-auth.md) remains in force.

A server-side cookie jar would share a session between viewers, lose state on endpoint replacement, and require the proxy to implement browser path and expiry rules. A separate gateway or a trusted-proxy mode in each application solves only individual applications and adds another process.

Capability authorization remains mandatory and foreign Origin is preserved, but neither replaces application CSRF protection. Applications relying only on SameSite need additional checks. Cookies read or written directly by JavaScript retain their prefixed names in the browser; this is not full cookie or OAuth transparency. Browser support for partitioned cookies varies. Local ports share a cookie host: namespacing avoids accidental collisions, but scripts can read or modify another endpoint’s non-HttpOnly cookies.

## Verification

The [proxy boundary tests](../../../../apps/cli/src/preview/local-preview-proxy.test.ts) cover HTTP, WebSocket, endpoint separation and response attributes. Real browser and Quick Tunnel behavior require separate validation.
