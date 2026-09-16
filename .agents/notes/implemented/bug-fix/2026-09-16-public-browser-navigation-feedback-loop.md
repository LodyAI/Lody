# Public browser navigation state must not become a new navigation intent

Status: implemented
Translation: current

[中文](2026-09-16-public-browser-navigation-feedback-loop.zh.md)

## Abstract

The desktop public browser can feed a native URL observation back into the
renderer as if it were a new address-bar request. Real Electron/Playwright
diagnostics reproduced this extra navigation for redirects, history movement,
same-document hash changes, and `window.open`; `baidu.com` is one visible
instance because it resolves to `www.baidu.com/`. The current evidence points
to an ownership/timing error between the native state stream and the renderer's
navigation request identity, not to a connect-reset failure. `www.baidu.com`
also produces several loading state updates, but the current direct-load sample
did not produce a second `navigate`; a committed deterministic renderer-panel
fixture would still improve future coverage, but is not required for the
controller fix adopted here.

## Evidence

The diagnostic matrix launched the built OSS Electron desktop through the
existing E2E harness and observed the real preload, IPC, `WebContentsView`, and
main-process service. It temporarily emulated the panel's URL observation
feedback in the renderer; the diagnostic code was not committed because the
E2E suite forbids live network scenarios.

- `baidu.com` and `https://baidu.com` normalize to `https://baidu.com/`, then
  receive `https://www.baidu.com/`; when the renderer observation path echoes
  that URL, it causes a second `publicBrowser.navigate` and a second main-frame
  navigation. The first navigation then reports `did-fail-load` with code `-3`
  (`ERR_ABORTED`) before the second navigation commits.
- `http://baidu.com` showed the same extra navigation through the HTTPS/www
  redirect.
- `www.baidu.com` and `www.baidu.com/` both normalize directly to
  `https://www.baidu.com/`; this matrix did not show a second URL-driven
  navigation, although five loading state events preceded `ready`.
- Public history Back and Forward each produced an observed URL change that
  was then sent back through `navigate` without a new address-bar request.
- A same-document hash change and a page-triggered `window.open` likewise
  produced a second `navigate` from the observation path.
- Reload, Stop during load, rapid address replacement, and hide/show/rebind did
  not produce an additional URL-driven navigation in the diagnostic matrix.
- All tested IPC operations returned `ok: true`. The only failure observed in
  the feedback-loop sample was the expected cancellation code `-3` on the
  superseded main-frame load; no connection-reset code `-101` or public-browser
  error state was observed. This does not rule out network failures in a user's
  particular environment, but it provides no evidence that connection reset is
  the primary trigger here.

The relevant ownership boundary is visible in
[`PublicBrowserSurface`](../../../../packages/components/src/components/sessions/public-browser-surface.tsx),
where navigation is deduplicated by request ID plus URL, and in
[`SessionBrowserPanel`](../../../../packages/components/src/components/sessions/session-browser-panel.tsx),
where native state URLs update the current address. The native service emits
redirect and same-document observations from
[`PublicBrowserService`](../../../../apps/electron/src/main/services/public-browser-service.ts).

## Implemented direction

The renderer now stores an explicit public navigation request as `{ id, url }`
with a monotonic session-scoped ID and passes that request to
`PublicBrowserSurface`. Native URL observations still
update the address and history, but cannot replace the pending explicit request,
so redirects, same-document navigation, and history movement do not re-enter
`loadURL`. The surface reports a matching request as consumed only when it is
ready to dispatch it; the controller then clears that request. An undispatched
request therefore survives a surface remount, while a dispatched request cannot
be replayed by a fresh surface instance. Request IDs are not derived from the
currently pending request, so a consumed request followed by a retry of the
same URL still reaches native navigation. The surface also memoizes the Electron
bridge, preventing ordinary state renders from repeatedly tearing down and
rebuilding the native view's visibility/layout effects. Page-opened destinations
remain native-owned and are not reclassified as address-bar requests.

## External research

Electron's current [`webContents` documentation](https://www.electronjs.org/docs/latest/api/web-contents)
distinguishes document navigation events from in-page navigation: `did-navigate`
is main-frame-only, while `did-navigate-in-page` reports URL changes that do not
reload the document. It also documents `did-start-navigation.details.isSameDocument`
and `contents.isLoadingMainFrame()` as main-frame-aware signals. The official
Electron issue [#30479](https://github.com/electron/electron/issues/30479) records
that older Electron versions could report iframe activity through
`did-start-loading`/`did-stop-loading`, but this is historical issue evidence,
not a current Electron 39 guarantee. In the current runtime sample,
`www.baidu.com` produced no subframe navigation events; its repeated loading
states therefore remain an application-state/engine-spinner observation, not
proof of iframe activity.

Electron's official [Navigation History example](https://www.electronjs.org/docs/latest/tutorial/navigation-history)
uses `navigationHistory.goBack()`/`goForward()` for history commands and sends a
separate navigation-update notification from `did-navigate` and
`did-navigate-in-page`; it does not turn those notifications back into
`loadURL` calls. React's official [`useEffect` guidance](https://react.dev/reference/react/useEffect)
also says dependencies are compared with `Object.is`, warns that objects and
functions created during render can re-run effects unnecessarily, and recommends
designing effect setup/cleanup as an independent synchronization process.

The search therefore supports two separate checks before implementation: use a
main-frame/document-aware loading signal for the spinner state, and keep native
navigation observations one-way so they cannot re-enter the explicit
`loadURL`/`navigate` path. The observed `-3` is cancellation caused by that
second load, not `CONNECTION_RESET` (`-101`). Electron's 2025 re-entrancy fix for `loadURL`
([PR #48004](https://releases.electronjs.org/pr/48004)) is an additional reason
not to invoke `loadURL` synchronously or re-entrantly from navigation callbacks.

## Verification limits

The repository's active E2E registry currently contains no Browser navigation
journey, so the passing P0 smoke run (5/5 scenarios) does not cover this
surface. A controller regression test now covers the invariant, but the focused
Vitest run is blocked by the package's existing React 19 test-environment issue:
`act` is not exported where the existing suites expect it. The component package
typecheck and Electron build passed. `pnpm run docs check` completed with
pre-existing warnings and no errors.
