# Direct push client boundary

Status: implemented
Translation: current

[中文](2026-10-16-direct-push-client.zh.md)

## Abstract

Shared notification settings select OneSignal by default and direct registration
only when the hosted configuration explicitly enables it. Direct mode registers
native tokens or browser subscriptions through injected authenticated operations.
Native shells and explicitly opted-in, capable browsers are supported. Web uses
a configured VAPID public key and a dedicated Service Worker. The private native shell owns
OS registration and ActivityKit; the hosted backend owns delivery. The provider facade retains existing settings and local Electron
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
In direct mode, settings report success only after a backend save in the current generation;
native hosts await the initial OS token/upload and serialize local commands without
queuing logout behind network uploads. Logout revokes native registration even
before the authenticated port or delayed login exists, and invalidates scheduled
login tasks. Direct hosts must bind subscriptions to the actual login session and reject
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

The restored SDK preserves third-party identity and script loading as a deliberate
rollback option. A separate shared backend client would violate the platform boundary,
so provider selection still arrives through the authenticated route's injected port.
OneSignal login uses `lody-push-v2:<userId>`: only devices that reopen the restored
client join this namespace; identities abandoned by direct-only clients cannot be
reactivated by a provider switch. The host must use the same namespace for delivery.
Opt-out and logout revoke both providers. An absent Web preference preserves an
existing OneSignal subscription, while new Web subscriptions require explicit opt-in.

OneSignal retains its SDK-managed identity lifetime: it does not inherit the direct
backend's session-revocation guarantee. A server-side session-bound enrollment scheme
would be required for that guarantee. Provider switching requires current clients;
offline clients cannot install a removed SDK from a remote configuration change.

## Native mobile clients

The independent Swift and Kotlin clients under `apps/mobile` do not consume the
shared Web/Capacitor facade. Their process-owned notification coordinators read
`pushSubscriptions:configuration` and select OneSignal unless the successful
response explicitly enables direct delivery. Query failures do not authorize a
provider change. Native OneSignal logins map raw account IDs to
`lody-push-v2:<userId>`; payload recipient checks and navigation retain raw IDs.
Mixing these namespaces silently leaves a valid SDK subscription unreachable by
the sender. Old provider identities are not merged into the new namespace.

Direct registration uses a stable installation UUID and the authenticated app
session. iOS submits its actual Bundle ID, while Android supplies a token from
its configured Firebase project. Provider secrets remain server-owned. The
notification coordinator owns credential snapshots, serializes cleanup against
registration and fences retired local account work. A transport timeout is not proof
of server cancellation or commit order: ambiguous writes can race later server
operations. These clients do not add server-side registration generations.
Notification failures are isolated
from sign-in and conversation availability; foreground/auth refresh retries
registration rather than replaying notifications. iOS does not restore removed
Live Activities.

A backend switch alone cannot re-enroll offline devices. Accepted OS/provider
messages can arrive after logout, and OneSignal does not inherit direct delivery's
server-side session revocation guarantees. Keep this limitation distinct from
client click ownership checks. Native checks cover the lifecycle and routing
boundaries; real provider credentials, OS permission/signing and device delivery
still require platform acceptance tests.

## Verification

Behavioral tests cover native token upload, opt-out, late callbacks, Web
permission/explicit opt-in gates, key rotation, refresh, reload-before-login logout,
logout-cancelled deferred login, and failure versus confirmed registration. Real APNs/FCM delivery and Xcode compilation
require the private host's credentials and Apple toolchain; these tests do not
establish delivery. There is no automatic retry or exactly-once delivery claim.
