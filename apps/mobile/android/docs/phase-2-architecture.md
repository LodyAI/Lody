# Phase 2 implementation

The app stays in one Gradle module. Construction is explicit in LodyApplication. No database, Retrofit, serialization plugin, dependency-injection framework or second native Streams stack was introduced. Native HTTP uses pinned OkHttp 5.2.1; existing org.json stays inside wire adapters. Shared browser dependencies pin patched Zod 4.6.7.

```text
CloudProbeActivity → AccountController → CloudAuthApi → fixed-origin native HTTP
                         ↓
                  CredentialStore → Android Keystore key + private ciphertext

CloudProbeActivity → CloudProbeController → RuntimeOwner(account/workspace)
                         ↓                       ↓
                  account-bound grant     ReadOnlyCloudRuntime
                                                 ↓
                                      local NetworkRuntime.html
                                                 ↓
                                    shared Streams/CRDT read loop
```

AccountController serializes device authorization, restore, cancellation and logout. It fences results by account epoch, validates the account before saving credentials, and hides both bearer token and device_code from UI state. Local logout completes even when remote revocation is unavailable. A current grant 401 schedules account invalidation without awaiting cancellation of its own requesting runtime. A stale 401 cannot invalidate a newer credential.

Credentials are AES-GCM encrypted with a non-exportable Android Keystore key and associated data identifying this app/store. Atomic ciphertext writes live in noBackupFilesDir; backups are disabled. Tampering or a missing/invalidated key removes unreadable state and requires login. No desktop credential is read or imported.

Native auth uses backend.lody.ai only, public Device Flow with the registered lody-cli client, no redirects/cookies/cache/logging, a one-MiB response limit and cancellation of the underlying HTTP call. The browser authorization URL is restricted to the official sites. Workspace grants are native-owned, short-lived values; only those enter WebView.

The cloud document is bundled locally at the existing secure origin. Its CSP contains the validated grant's exact gateway origin. Native interception and the fetch adapter both restrict requests to the chosen workspace's meta/machine catalog paths. Writes, RPC paths, other workspaces, remote scripts, external navigation and redirects are refused. CORS preflight is allowed only for the same admitted stream paths. Fetch omits cookies, limits response bodies, and aborts owned reads on background; queued reads wait for foreground.

The unchanged shared runtime starts with no user identity and presence disabled, which suppresses its otherwise implicit git-state Machine RPC. The adapter exposes connect/grant and the existing control methods; it does not expose sends. A renewed official grant with a different validated origin causes owner replacement and a new exact permission, rather than broadening the old view's access.

Grant acquisition is coalesced and fenced by WebView generation. Native cancellable retry with capped backoff handles failures even before JS starts its read loop. Lifecycle suspension, replacement, logout and account changes cancel pending grant work. Live status comes only from shared-runtime synced events; heartbeat readiness alone is not cloud synchronization. The probe keeps counts, not a second catalog replica or durable cache.

## Verification scope

Deterministic JS/JVM/device tests cover protocol boundaries, account cancellation and revocation, epoch fences, encrypted storage, grant retry/migration, background behavior and the complete phase-1 regression suite. Official Device Flow authorization and authenticated workspace discovery were verified with the user. The real Lody workspace reached LIVE with 43 projects, 1,793 sessions and 15 streams. Disabling both emulator networks produced UNAVAILABLE; restoring them recovered LIVE automatically after approximately two minutes. Background resume also returned to LIVE, with transient network_or_auth states observed. Force-stop/relaunch restored the account and workspace list without new authorization. Individual long-poll HTTP requests, natural token-expiry renewal, sustained stability and physical devices remain unverified. See verification/phase-2-results.json; deterministic tests and observed cloud behavior are recorded separately.

## Deferred review notes

- Preserve the initial grant's receipt deadline before first delivery; currently an aged token is recovered through the shared read loop's server-rejection/regrant path.
- Refine AuthFailure-to-RuntimeFault category mapping; currently provider errors use AUTH even for network failures. Error codes remain distinct and retry behavior uses those codes.
- Full catalog persistence, product navigation and sends remain later stages.
