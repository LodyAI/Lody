# Keep notification click handlers alive after delivery

Status: implemented
Translation: current

[中文](2026-09-20-notification-click-lifetime.zh.md)

## Abstract

A desktop completion notification could activate Lody without opening its conversation.
The main process kept the notification wrapper only while awaiting delivery, leaving
its click handler vulnerable to garbage collection afterward. The notification service
now retains wrappers until click, close, or failure, preserving the existing session
navigation path. Deterministic tests and an isolated Electron 39.5.1 probe verify retention
and click IPC delivery; a real banner click through the full chat UI remains unverified.

## Cause and ownership

[Electron 39.2.6's notification destructor](https://github.com/electron/electron/blob/v39.2.6/shell/browser/api/electron_api_notification.cc#L68-L71)
clears the native delegate. Lody's click handler already focuses the main window and
sends `app.sessionCompletionClick`, and the renderer already navigates to the supplied
workspace/session. Losing that delegate can therefore bypass navigation even when the
operating system activates the application. The isolated probe below reproduces wrapper
collection in the old code, but does not replay the user's original click.

[NotificationService](../../../../apps/electron/src/main/services/notification-service.ts)
owns a strong set. The [delivery helper](../../../../apps/electron/src/main/services/notification-delivery.ts)
adds each notification before showing it and releases it on click, close, failure, or a
synchronous show exception. A successful `show` still settles IPC immediately but keeps
the wrapper alive. Cleanup removes only its own listeners and preserves other active
notifications. No expiry timer guesses when a notification is no longer actionable;
if native terminal events never arrive, the wrapper remains until process exit.

This extends the [delivery-result decision](2026-09-13-electron-api-preparation.md)
without changing its success/failure semantics or the existing navigation target.
It does not restore notification callbacks across application restarts.

## Verification

The five tests in `notification-delivery.test.mjs` pass under Node's type stripping.
They exercise pending/delivered retention, independent clicks, dismissal, native
failure, and synchronous exceptions using explicit events, without GC timing or sleeps.
An isolated macOS process used the cached Electron **39.5.1** runtime matching the lockfile,
with a temporary user-data directory and synthetic session/workspace IDs. The probe
transpiled the actual service and delivery helper from `git show HEAD:<path>` and the
working tree into separate CommonJS modules. Only window-state and error-formatting
imports were substituted; notifications, the window, and IPC used real Electron APIs.
A constructor proxy recorded each wrapper through `WeakRef`, without retaining it.

After native `show` settled, an explicit event-loop boundary and awaited major GC
(`gc({ type: 'major', execution: 'async' })`) produced these results:

| Observation                                                               | Before                         | After          |
| ------------------------------------------------------------------------- | ------------------------------ | -------------- |
| Native notification emitted `show`                                        | Yes                            | Yes            |
| Wrapper survives explicit major GC                                        | No                             | Yes            |
| Injected `click` reaches the renderer with the expected session/workspace | Unavailable: wrapper collected | Yes            |
| Service retains the wrapper after click                                   | No retention existed           | No: set size 0 |

The surviving wrapper received `emit('click')`; the real service handler delivered
`app.sessionCompletionClick` to a synthetic renderer, which displayed the received
session ID. This verifies wrapper lifetime and main-to-renderer IPC, **not** the OS
banner's mouse activation or TanStack navigation to the complete chat page. Both probe
processes exited. No production profile, conversation, or running Lody process was used.
The GC probe is an isolated diagnostic; the committed regression suite remains driven
by explicit synthetic events rather than garbage-collection scheduling.

`pnpm check` stops because this nested checkout lacks dependencies (`tsgo` unavailable);
repository instructions prohibit installing them here.
`pnpm run docs check` reports existing broken links into absent ACP submodules;
none refer to the changed files. `git diff --check` passes.
