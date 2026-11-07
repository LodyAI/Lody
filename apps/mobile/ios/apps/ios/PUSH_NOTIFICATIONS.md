# Native OneSignal integration

The iOS-only app keeps bundle ID `ai.lody.mobile` and uses the public OneSignal App
ID `e383bf31-7c8e-4641-b3f6-3486e77b9a82`. `LODY_ONESIGNAL_APP_ID` can override it at
prebuild time (an empty value disables initialization). No REST API key or APNs
private key is shipped in the app.

OneSignal iOS **5.5.1 Stable**, selected from the official
https://onesignal.github.io/sdk-releases/releases.json, is pinned in `project.yml` and resolved by Swift Package Manager. LodyKit owns initialization, identity, subscription observation, click
buffering and foreground policy. The Notification Service Extension uses the same
SDK version and App Group `group.ai.lody.mobile`.

## Build and configure

1. Configure this OneSignal App's iOS platform for `ai.lody.mobile` and its APNs key.
2. Keep automatic signing and choose your Apple team. Register Push Notifications
   and the App Group for the app, and the same group for the NSE identifier
   `ai.lody.mobile.notification-service`.
3. Run `pnpm prebuild`. XcodeGen creates the app, LodyKit, NSE and Share targets.
4. Open the project with `pnpm ios` and Run in Xcode, or use `xcodebuild` with normal signing.
   The app embeds `LodyNotificationService.appex` and `LodyShare.appex`. Changing the OneSignal App ID or
   native configuration requires a new native build, not an OTA update.
5. Configure Convex's generic `ONE_SIGNAL_APPS` inventory and the new app's secret
   API key as documented in that backend's `PUSH_NOTIFICATIONS.md`.

## Runtime behavior

The native SDK requests notification permission immediately after OneSignal
initialization during app launch. iOS displays the system prompt only while the
authorization status is undetermined; after a denial, Settings → Notifications is the
manual entry. After account restoration, the SDK uses the Better Auth user ID as its
external ID. Login does not trigger another permission request. Logout detaches and
opts out the current subscription, clears delivered notifications, and drops buffered
clicks. Offline logout cannot synchronously revoke a remote provider binding; use
neutral lock-screen previews.

The SDK's Web launch URL is suppressed. `LodyApplication` handles `data.route` after auth and
navigation become ready, checks the recipient and workspace, selects the workspace,
then resolves the real Session from its catalog. Missing sessions wait during sync;
completed sync reports an unavailable session. Foreground notifications for the
focused session are suppressed. Permission data opens the session rather than
executing an approval from a notification.

The Debug page's **Verify OneSignal subscription** action observes a real server
subscription (nonempty, not `local-`) and shows the official integration dialog once
per process; the button can request permission. This developer-only scaffolding is
kept out of product flows. Only subscription readiness is exposed, not token/ID data.
In-app messages, email/SMS, and tags are not enabled by this integration.
