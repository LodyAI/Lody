# Direct push client boundary

Status: implemented
Translation: current

[中文](2026-10-16-direct-push-client.zh.md)

## Abstract

Shared notification settings previously loaded a vendor SDK and delegated device
identity to it. The client now registers native tokens or browser subscriptions
through injected authenticated platform operations.
The first release enables native shells only; browser support is deferred even
when VAPID configuration exists. Browser transport code is retained but dormant. The private native shell owns
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

Account changes invalidate old callbacks; sign-out stops local registration and
attempts bounded server cleanup before auth state disappears. Web subscriptions
use a dedicated worker scope; the hosted worker binds display and clicks to the
recipient account. Browser permission alone does not mean a subscription exists.

Keeping the old SDK would preserve third-party identity and script loading;
a separate shared backend client would violate the platform boundary. The chosen
facade preserves the current settings contract without either dependency.

## Verification

Behavioral tests cover native token upload, opt-out, late callbacks, Web
support remaining disabled even with permissions and VAPID configured. Real APNs/FCM delivery and Xcode compilation
require the private host's credentials and Apple toolchain; these tests do not
establish delivery. There is no automatic retry or exactly-once delivery claim.
