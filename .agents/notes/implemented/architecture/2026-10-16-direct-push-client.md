# Direct push client boundary

Status: implemented
Translation: current

[中文](2026-10-16-direct-push-client.zh.md)

## Abstract

Shared notification settings previously loaded a vendor SDK and delegated device
identity to it. The client now registers native tokens or browser subscriptions
through injected authenticated platform operations.
Native shells and explicitly opted-in, capable browsers are supported. Web uses
a configured VAPID public key and a dedicated Service Worker. The private native shell owns
OS registration and ActivityKit; the hosted backend owns delivery. This removes
vendor runtime dependencies while retaining existing settings and local Electron
notifications. Provider acceptance and native device delivery remain separate
verification boundaries.

## Decision

`lib/push-notifications.ts` owns subscription lifecycle, language, permission and
installation identity. `cloud-api-operations.ts` declares portable registration
DTOs; the authenticated route injects mutations. Local desktop never installs or
uses a hosted push transport. The native host implements `window.__LODY_PUSH__`;
no Capacitor runtime import enters shared components. iOS registration carries
the actual native `bundleId` through the portable DTO so a host can route multiple
apps without putting provider credentials or configuration in shared code. The
host must allowlist app identities; the client field is not app attestation.

Permission and opt-in preference are distinct from confirmed registration.
Settings report success only after a backend save in the current generation;
native hosts await the initial OS token/upload and serialize local commands without
queuing logout behind network uploads. Logout revokes native registration even
before the authenticated port or delayed login exists, and invalidates scheduled
login tasks. Hosts must bind subscriptions to the actual login session and reject
sends after session revocation/expiry; bounded client cleanup alone is not authorization.

Account changes invalidate old callbacks; sign-out stops local registration and
attempts bounded server cleanup before auth state disappears. Web subscriptions
use a dedicated worker scope; the hosted worker binds display and clicks to the
recipient account. Browser permission alone does not mean a subscription exists.
Web Locks serialize origin-wide subscription changes; worker account updates must
be acknowledged after persistence. Logout clears durable browser authorization
even before delayed in-memory login. Focus and subscription-change messages
reconcile rotated keys/endpoints; closed workers never store session credentials.
A browser requiring a fresh user gesture can require explicit re-enablement.

Keeping the old SDK would preserve third-party identity and script loading;
a separate shared backend client would violate the platform boundary. The chosen
facade preserves the current settings contract without either dependency.

## Verification

Behavioral tests cover native token upload, opt-out, late callbacks, Web
permission/explicit opt-in gates, key rotation, refresh, reload-before-login logout,
logout-cancelled deferred login, and failure versus confirmed registration. Real APNs/FCM delivery and Xcode compilation
require the private host's credentials and Apple toolchain; these tests do not
establish delivery. There is no automatic retry or exactly-once delivery claim.
