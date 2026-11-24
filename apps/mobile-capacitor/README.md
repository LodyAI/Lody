# Capacitor mobile client

This cloud client composes the shared UI and `@lody/client-e2ee` with native
Keychain/Keystore adapters. It is independent of the native projects in
`apps/mobile`. Supply build-time cloud URLs yourself; no deployment credentials
or environment files are included. See [build requirements](BUILDING.md).

### Native builds

From the repository root:

```bash
pnpm --filter @lody/mobile-capacitor build:ios
pnpm --filter @lody/mobile-capacitor build:android
pnpm --filter @lody/mobile-capacitor nightly:ios
pnpm --filter @lody/mobile-capacitor nightly:android
```

Nightly uses the same `prod` environment variables and sync/open steps as the
corresponding build command, with the existing Lody Nightly artwork as the app icon.
The app name and bundle/application ID are unchanged, so it replaces the regular
app rather than installing alongside it. On iOS, choose the default icon in
Appearance if an alternate icon was previously selected.

The icon selector stays active when the native IDE opens. Running a regular
`build:*`, `dev:*`, or `ci:sync:*` command switches back to the regular icon.
Nightly assets are generated and ignored by Git; do not commit the temporary
Xcode project or Android manifest icon selection.

### iPhone Duo

The iOS shell adapts its safe viewport and keyboard offset to the current window.
The shared UI selects phone or wide layouts by available width, including after
folding and Split View resizing. When UIKit reports enough unobstructed side
space, the mobile dock and selected chat actions use a native side rail; otherwise
the ordinary web controls remain available. Full-display builds require Xcode/iOS SDK 27.1+:

```sh
pnpm --filter @lody/mobile-capacitor build:ios:duo
```

See [build requirements](BUILDING.md#iphone-duo) and the
[implementation note](notes/2026-10-27-iphone-duo.md).

### iPhone Home Screen widgets

Live Activity summaries and Home Screen widgets require a matching runtime in
explicit plaintext mode. Encrypted or unresolved workspaces end the activity and
clear widget snapshots; decrypted session titles, permission commands and agent
names stay inside the app.

The **Conversation progress** widget supports small and medium sizes. The small
widget features one conversation; the medium widget shows up to three, with task
title, agent, status and recent activity. Conversations waiting for your response
come first, followed by running conversations and new replies.
Build/install the iOS app, launch it and open a workspace, then add Lody from the
iPhone widget gallery. Tapping the widget opens Lody.

The app publishes a local snapshot while running and on resume. The conversation
snapshot becomes stale after 15 minutes; its scheduled expiry timeline entry
replaces details with an **Open Lody** prompt when WidgetKit presents that entry.
Signing out or leaving the ready workspace clears
its cached summary; iOS controls when that change appears on the Home Screen.
Cache expiry does not erase stored metadata. The widget uses the existing extension and
App Group, independently of Live Activity and notification settings.

The **Token usage** widget shows the current workspace's Token total and hourly
trend in both sizes. The medium widget adds the two largest model totals, or
input/output/cache-read totals when the server reports that breakdown. Statistics
cover the returned UTC period: a UTC calendar day is labelled **Today · UTC**;
other windows show their explicit date/time bounds. Values use the app's language.
This is workspace-wide usage, not a personal allowance or a billing quota.
Token source data expires after 15 minutes; its scheduled expiry entry shows a
refresh prompt. iOS may present that entry later. Reopening the app cannot make
an unchanged old server window fresh.

The **Agent limits** widget separately shows remaining subscription allowances
for supported providers such as Codex, Claude and Kimi. Small shows one provider;
medium shows up to three, with quota windows, reset times and the source computer.
Small uses the same top-left Lody logo/name and workspace header as the conversation
widget, with provider identity below it. Contrasting rings show remaining allowances
and centre a single window; source-computer information stays in the footer.
Medium compares providers with aligned allowance bars, drawing only reported
windows. A 7d-only account has no fabricated 5h bar. The common computer name
moves to the footer; low allowances and expired windows get a compact reset or
refresh hint under the affected provider's name. The medium footer keeps only the source
and snapshot label, without an open/refresh action caption or arrow. Medium keeps
an additional inset around its quota columns.
Opening/foregrounding Lody requests fresh limits through an online computer's
existing provider connection. The computer needs a runtime advertising quota
query support. Vendor credentials stay on that computer. The widget reads only a
local snapshot: unknown data is omitted, elapsed reset windows ask for a refresh,
and the cache becomes stale after 15 minutes. A recently copied snapshot does not
prove a recent vendor fetch; the upstream rows currently carry no fetch timestamp.

Implementation and verification: [Home Screen widget note](notes/2026-10-12-home-screen-widget.md)
([中文版](notes/2026-10-12-home-screen-widget.zh.md)).

During metadata loading, conversation and allowance widgets retain the same owner's
snapshot with its original expiry; Token queries run independently. Failed native
writes retry after 1, 5 and 30 seconds. See the
[cache recovery decision](notes/2026-10-31-widget-cache-recovery.md).

## Blank screen recovery (two layers, do not merge them)

Returning from background can show a white screen for two different reasons, and
each layer must only handle its own:

- **JS alive, DOM gone** — `src/resume-recovery.ts`. Listens for Capacitor
  `appStateChange`, checks `#root` is empty, reloads once with a 30s cooldown.
- **No document at all** (iOS killed the WKWebView web content process) —
  `ios/App/App/LodyBridgeViewController.swift`. The JS layer cannot see this: its
  listener died with the content process. Capacitor's own
  `webViewWebContentProcessDidTerminate` reload fires while backgrounded, where a
  load can be suspended or fail with no retry (`errorPathURL` is unset), so the
  native layer re-checks on `didBecomeActive` and calls `loadWebView()`.

The native guard reads the stable `index.html` title via `webView.title`.
Never write `document.title` or broaden `rootLooksBlank()` to mounted-but-stuck
React: reloading a live app discards in-flight work.
