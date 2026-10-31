# Preview application cookies

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/2016

[中文](2026-10-28-preview-app-cookies.zh.md)

## Abstract

Application sessions need cookies for resources and WebSocket upgrades. The preview proxy scopes application cookies to the local Session and target origin, or the remote endpoint, and keeps its capability token out of the target. Local viewer hostnames isolate Chromium cookie quotas; app Set-Cookie responses reissue the capability last. It forces partitioned cross-site attributes to work in an embedded viewer. This weakens SameSite CSRF protection and changes names visible to application scripts.

## Decision and alternatives

Local names use `lody_app_<scope>_<name>`, where scope is a truncated SHA-256 hash of the Session ID and target origin. Remote names use the endpoint ID. The proxy restores the original name on the way to the target. A local replacement reuses cookie names but generates a new capability value; different Sessions and target origins do not share names. Each local scope has a stable `lody-<scope>.localhost` viewer hostname, while the proxy reserves the same port on 127.0.0.1 and ::1 before exposing the URL. Chromium can prefer ::1: a synthetic two-listener reproduction sent a localhost-subdomain request to a different IPv6 listener when only IPv4 was reserved. Port conflicts retry; IPv4-only operation is permitted only when IPv6 is unavailable. Chromium treats the names as separate embedded sites. Its partitioned-cookie quota is about 10 KiB per embedded site and top-level partition; applications may lose cookies under pressure. Reissuing the capability last after app Set-Cookie protects it in the tested response flow. It does not guard against direct JavaScript cookie writes or guarantee other browsers behave identically. The 1 MiB local parser limit bounds headers for clients with larger jars; it is not Chromium’s cookie quota. It removes Domain and forces Secure, SameSite=None and Partitioned, retaining Path, expiry and HttpOnly. Browsers enforce the resulting scope and expiry. The [local capability decision](2026-10-04-local-preview-module-auth.md) remains in force.

A server-side cookie jar would share a session between viewers, lose state on endpoint replacement, and require the proxy to implement browser path and expiry rules. A separate gateway or a trusted-proxy mode in each application solves only individual applications and adds another process.

Capability authorization remains mandatory and foreign Origin is preserved, but neither replaces application CSRF protection. Applications relying only on SameSite need additional checks. Cookies read or written directly by JavaScript retain their prefixed names in the browser; this is not full cookie or OAuth transparency. Browser support for partitioned cookies and localhost subdomains varies. Some OS resolvers do not resolve these browser viewer names; the target transport remains independently bound to its approved literal loopback address.

## Verification

The [proxy boundary tests](../../../../apps/cli/src/preview/local-preview-proxy.test.ts) cover HTTP, WebSocket, endpoint separation and response attributes. A synthetic Chromium fixture under HTTP and file top-level pages exercised the actual proxy and desktop CSP: four 3.5 KiB app cookies could no longer make tokenless-Referer resource requests in either of two previews fail. The old proxy returned 403 with the same fixture. Packaged Electron and real Quick Tunnel behavior remain unverified.
