# Native push integration

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

The app requests system notification permission at launch, independently of the
provider. Login never prompts. Auth restoration supplies the raw account ID and
its native login credential to the process-owned registration lifecycle.

`pushSubscriptions:configuration` currently returns **`selfHostedEnabled`**, not
`selfHosted`. Only a decoded Boolean selects the provider: true uses direct APNs,
false uses OneSignal. Missing/malformed responses and network errors do not select
a default; a previously confirmed provider is retained and the next foreground or
permission refresh retries. OneSignal initializes lazily and logs in with
`lody-push-v2:<userId>`. Native account IDs and notification recipients stay raw.

Direct APNs registration sends platform `ios`, purpose `notification`, the token,
language, a persistent random installation ID, and the running app's actual Bundle
ID. The backend owns APNs environment selection and requires a live auth session.
No APNs key, JWT, token or installation ID is logged. There is no ActivityKit path.

Registration, provider retirement and logout cleanup use a serial process-owned
queue with the captured login credential. Each HTTP operation has a 15-second
request timeout. Pending client writes settle before retirement and successor writes;
stale configuration, permission and success callbacks cannot revive local state.
A transport timeout does not prove that a server operation stopped: an ambiguous
registration or unregister can still race later server operations. This is local
serialization, not server-side registration-generation ordering.
Logout detaches OneSignal and clears local notification state immediately without
waiting for network cleanup. Cleanup failure is reported as unconfirmed, never as
success; foreground refresh can retry, and backend session revocation is the final
delivery fence. Offline logout cannot promise immediate remote revocation; use
neutral lock-screen previews. The queue protects push writes only, not app startup,
navigation, runtime teardown or sign-out completion.

Provider transitions opt out/logout OneSignal for direct APNs, retire direct APNs
when returning to OneSignal, and restore the appropriate notification-center delegate.
Direct APNs payloads use top-level `route` and `recipientUserId`; OneSignal uses
additional data. Both require an explicit raw recipient (legacy payloads without
one are rejected rather than attributed to whichever account is currently open).
Foreground delivery suppresses signed-out, wrong-account and visible-session pushes.

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

## Verification

`pnpm verify:native --case notifications` exercises the production lifecycle with a
deterministic backend boundary: permission gating, exact capability decoding,
Bundle-ID binding, provider transitions, retryable failures and a suspended old
registration completing across logout and same-user re-login. The existing click
buffer checks cover cold restoration, account replacement and stale acknowledgement.

A simulator build checks SDK/delegate integration, not APNs delivery. Physical-device
acceptance still requires both provider configurations, token rotation, cold clicks,
permission changes in Settings, foreground suppression and logout while offline.
