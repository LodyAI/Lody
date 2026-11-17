# Native notification ownership

- `PushNotifications.swift` owns OneSignal and direct APNs reception, raw-account click ownership, and permission observation. OneSignal login uses the original verified user ID without a prefix or identity conversion.
- `PushRegistration` owns provider selection from the exact Boolean `pushSubscriptions:configuration.selfHostedEnabled`, session-scoped credentials, and serialized registration/retirement. Never borrow the current Keychain credential during an old session's operation.
- Register only authorized notification tokens with the actual `Bundle.main.bundleIdentifier`. Never add ActivityKit.
- Auth invalidation immediately fences local callbacks. Remote cleanup is best effort and ordered behind in-flight writes; backend session revocation is the delivery authority. Failures remain retryable on foreground refresh and must not block logout or unrelated app work.
- Keep recipient IDs raw and mandatory. Cold clicks survive until auth is known, then the existing account/workspace/catalog routing policy validates them.
