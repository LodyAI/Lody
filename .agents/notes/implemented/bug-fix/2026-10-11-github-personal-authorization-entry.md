# Restore native GitHub personal authorization entry

Status: implemented
Translation: current

[中文](2026-10-11-github-personal-authorization-entry.zh.md)

## Abstract

Cloud-capable native clients showed “Authorization needed” after personal identity
was enabled, but hid the action needed to resolve it. Native settings now expose
Authorize and open the current workspace's GitHub settings in the external browser.
The browser owns account linking, while the client's existing reactive query shows
the resulting authorization. This avoids starting browser-cookie OAuth inside a
native shell; users may need to sign into the same Lody account in the browser.

## Decision and evidence

`canAuthorizePersonalGitHub` previously excluded Electron and native shells in
both desktop and responsive mobile settings. Allow those hosts when the workspace
slug is available, and use a shared destination builder with `VITE_SITE_URL` and
its production fallback. Opening failures use the existing error toast and release
the busy state for retry. No token or session credential is put in the URL.

Keep the web linking flow and the `githubIntegration` capability boundary. The OSS
local desktop still has no GitHub cloud settings. Launching OAuth directly from the
native auth client was avoided because its redirect/cookie context differs from the
browser. This complements the earlier
[personal authorization state fix](2026-09-30-github-personal-identity-silent-fallback.md).

## Verification

The existing GitHub settings suite covers native missing/expired authorization,
external destinations, retry after an opening failure, browser account linking,
authorized-state action removal, and the local capability gate. Live GitHub OAuth
completion requires a real account and is not exercised by these deterministic tests.

Typecheck, lint, formatting, documentation, i18n and boundary checks passed. The
full check stopped on two CLI environment failures; both suites passed (25 tests)
with a canonical temporary directory and without session-injected Git wrappers.
