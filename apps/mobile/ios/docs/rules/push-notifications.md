# Push notifications (iOS)

Read before changing push registration, the Notification Service Extension or notification navigation. These rules bind every caller of the area, not only files in its directory.

- Native OneSignal SDK ownership stays in LodyKit `Notifications/PushNotifications.swift`;
  `PushLifecycle` initializes at app launch, retains SDK listeners and caches
  clicks until `LodyApplication` resolves and acknowledges them. `PushRegistration` serializes
  session-bound APNs writes; only the exact `configuration.selfHostedEnabled` Boolean
  selects direct APNs. OneSignal uses the original verified `userId`, unchanged, as does native ownership.

- `project.yml` and `App` persist the NSE, App Group,
  SDK pin and entitlements across prebuild. Never fix only generated `ios/` files.

- Notification navigation accepts only the legacy workspace/session route and resolves
  against the signed-in user's catalog. `recipientUserId` fences clicks after an
  account switch; payloads without a raw recipient are rejected.

- Debug's offline notification fixture never initializes OneSignal or requests real
  permission. See `apps/ios/PUSH_NOTIFICATIONS.md` for setup and verification limits.

- Live Activities are removed: do not restore ActivityKit registration, widget targets, notification toggles or verification hosts.
