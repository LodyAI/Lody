# Preview application cookies

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/2016

[中文](2026-10-28-preview-app-cookies.zh.md)

## Abstract

Application sessions need cookies for resources and WebSocket upgrades. The preview proxy gives each endpoint its own cookie names and forwards only that endpoint's application cookies, keeping its capability token out of the target. It forces partitioned cross-site attributes to work in an embedded viewer. This weakens SameSite CSRF protection and changes names visible to application scripts.

## Decision and alternatives

Both local and remote endpoints use `lody_app_<endpointId>_<name>`; the proxy restores the original name on the way to the target. It removes Domain and forces Secure, SameSite=None and Partitioned, retaining Path, expiry and HttpOnly. Browsers enforce the resulting scope and expiry. The [local capability decision](2026-10-04-local-preview-module-auth.md) remains in force.

A server-side cookie jar would share a session between viewers, lose state on endpoint replacement, and require the proxy to implement browser path and expiry rules. A separate gateway or a trusted-proxy mode in each application solves only individual applications and adds another process.

Capability authorization remains mandatory and foreign Origin is preserved, but neither replaces application CSRF protection. Applications relying only on SameSite need additional checks. Cookies read or written directly by JavaScript retain their prefixed names in the browser; this is not full cookie or OAuth transparency. Browser support for partitioned cookies varies. Local ports share a cookie host: namespacing avoids accidental collisions, but scripts can read or modify another endpoint’s non-HttpOnly cookies.

## Verification

The [proxy boundary tests](../../../../apps/cli/src/preview/local-preview-proxy.test.ts) cover HTTP, WebSocket, endpoint separation and response attributes. Real browser and Quick Tunnel behavior require separate validation.
