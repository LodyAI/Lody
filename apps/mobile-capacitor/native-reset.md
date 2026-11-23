# Native full-data recovery

The version-1 `window.__LODY_NATIVE_RESET__` contract is owned by public PR
LodyAI/Lody#1531. The shell installs it in `src/index.html`, before module loading,
only when Capacitor supplies the native plugin. Web and older shells leave it
undefined. The pinned public submodule at implementation time does not include
that PR; integrate it through the normal separate public-pointer promotion.

## iOS ownership

`LodyNativeResetPlugin.swift` covers the page with a native Resetting view,
navigates to `about:blank`, and waits for navigation completion. This releases
renderer storage connections and stops auth/network callbacks. It then drains
Capacitor's serial plugin queue before clearing credentials, so outgoing
Preferences writes cannot restore them. Native resume recovery and other
navigation are disabled while the reset owns the WebView.

Deletion uses the actual WebView's `configuration.websiteDataStore` and all
website data types. Each deletion is followed by record enumeration; remaining
records cause one retry, then rejection. There is no deletion timeout: the
operation cannot be cancelled, so releasing ownership on a timer could erase
storage created by a later sign-in. Success loads the configured server origin
at `/`, discarding path/query/fragment; its promise stays pending as the old
page goes away.

Navigation destroys the original renderer promise. On failure the native call
rejects, and a durable result in shell Preferences also hands recovery to the
fresh root's `src/bootstrap.ts`. Before importing the app it clears the browsing
context's SessionStorage; for a failed reset it also awaits the shared
`clearAllLodyLocalData()` web wipe. It never calls `startHardReset()` (which would
reenter native reset). Import/wipe failure shows the inline boot fallback and
leaves the app unloaded. Bootstrap acknowledges the result only after the shared cleanup
attempt returns; cleanup-module import failures, thrown wipe errors, and process termination
retain recovery for the next boot. The shared wipe is best-effort and swallows
some storage errors, so acknowledgement is not proof of empty web storage. Reading an interrupted result also attempts native credential cleanup.
Only auth Preferences determine cleanup success; unrelated shared cookies never
block boot. Consecutive credential failures are persisted: attempts 1–3 reject,
and attempt 4 continues with the shared web wipe and app import, marking
`native_reset_credential_cleanup_failed: true` in app diagnostics. This exception
applies only to credential verification, not arbitrary bridge/import/wipe errors.
If native credentials truly cannot be deleted, this degraded path cannot promise
sign-out. A new reset, successful cleanup, or acknowledgement clears the count. WebKit process termination before deletion begins hands
off to root recovery; termination during deletion cannot release its ownership.

No file-level fallback is attempted. Capacitor retains the WebView and process
pool, so this plugin cannot establish that unlinking Library/WebKit is safe.
Repeated verification failure returns to the renderer instead.

Auth scope is pinned to better-auth-capacitor 0.3.6 with `storagePrefix: 'better-auth'`:

- All `UserDefaults.standard` keys beginning with `CapacitorStorage.better-auth`
  are removed after the outgoing renderer and its queued credential writes stop.
  The dependency contract test deliberately fails when the catalog or installed
  Better Auth version (0.3.6), or installed Preferences version (8.0.1), changes;
  re-audit namespace/storage ownership before updating that guard.
- This auth package writes no Keychain items. The only shell Keychain items are the
  E2EE KEKs of `LodyKek` (fixed service `ai.lody.mobile.e2ee.kek.v1`), whose receipts live
  in Application Support `LodyE2eeCustody`. They protect only originals held in WebKit
  storage, so a full reset removes every item of that one service and then that directory,
  never another service, and never the entire Preferences domain. Live reset does this
  only after WebKit records are verified empty and every admitted `LodyKek` call has
  returned (`LodyKekCallQueue.fenced`); calls arriving meanwhile wait until the purge
  settles. A failure rejects the reset into root recovery. Fallback acknowledgement
  repeats it best effort after the shared web wipe and before the app import; a failure
  there never blocks boot, resolves with `custodyCleanupFailed: true` (bootstrap records
  `native_reset_custody_cleanup_failed`), and the next reset retries. A purge that
  settles after another reset began rejects the acknowledgement instead of clearing it.
- Shared native cookies are cleared best-effort, and `OneSignal.logout()` is
  called after renderer quiescence. The Cordova SDK initializes natively
  at launch with its saved app ID, including when the renderer fails to boot.
  Logout has no completion/error API; offline server propagation is SDK-owned.
- The existing install ID is copied from `__LODY_APP_INFO__.install_id` or
  `lody_install_id` into `LodyDiagnostics.installId` before deletion. A document-start
  script restores it to `__LODY_APP_INFO__` without repopulating localStorage.
  The mobile boot beacon prefers this preserved ID. Unrelated native preferences
  (including startup theme) remain untouched.
- All three Home Screen widget snapshots, including the legacy conversation key, are
  cleared from the existing App Group at this same quiescent boundary and during
  interrupted-reset boot recovery. Each widget timeline is invalidated; iOS owns
  when the empty state appears. Other App Group preferences remain untouched.
- `LodyDiagnostics.lastNativeResetOutcome` records only `success` or `fallback`.
  The document-start script injects `__LODY_APP_INFO__.last_native_reset_outcome`
  even without an install ID. It means the **last** reset, persists after recovery
  acknowledgement, and must not be treated as a new reset event on every launch.
  Bootstrap adds the current credential-cleanup failure flag before its web wipe.
  Mobile boot-failure diagnostics/beacons include these fields. Successful workspace
  outcome reporting in the public renderer can consume this bridge separately.

The inline watchdog and styled boot failure actions use the same native method,
with explicit destructive confirmation. They do not import auth code or depend
on React. A rejection before native navigation keeps diagnostics visible and
allows retry; after navigation the native result hands off to root recovery.
The public renderer owns its own session-revocation/web-wipe fallback. The inline-only path
clears local credentials but cannot revoke a server session without the auth bundle.
Android has no implementation in this change and retains web-level recovery.

## Validation

`pnpm --filter @lody/mobile-capacitor test` executes the real inline script with deterministic
DOM and timer fixtures: web/old-shell gating, unavailable localStorage, native
rejection propagation, confirmation, retry, styled/last-resort actions, preserved
ID, and a pending native navigation. Bootstrap tests verify that native result
reading, fallback deletion, and acknowledgement precede the app import, and that failure leaves
the app unloaded. `native-reset-contract.test.mjs` checks dependency versions
and compiles/runs the actual Foundation-only credential policy when `swiftc` is
available (explicit skip otherwise): recreated cookies, additional auth keys,
retained unrelated preferences, failure counts across policy recreation, and
counter reset. These tests do not validate WebKit deletion. The macOS custody suite
(`scripts/test-kek-ios.mjs`) runs the reset barrier against hung native calls and
typechecks the Keychain purge; it never touches a real Keychain.

On a test device, using an iOS build with public PR #1531 integrated:

1. Sign in and record the diagnostic install ID. In Safari Web Inspector, add an
   extra `lody-loro-repo-db-*` IndexedDB database with a `meta` store containing
   malformed data. An unused extra DB alone may not reproduce the stuck route;
   retain a known failing fixture/upgrade if necessary. Copy diagnostics before
   resetting, including the workspace/boot_wait_stuck PostHog event reference.
2. Invoke “Clear all local data and sign out” from recovery. Verify native cover,
   empty WebKit records, root/login navigation, and unchanged native diagnostic ID.
   Pause before the bundle reopens stores to inspect `indexedDB.databases()` and
   localStorage: both should be empty. Normal startup may create new storage.
   Verify SessionStorage, Cache Storage, service workers, cookies, and both native
   auth keys are gone; with an encrypted workspace opened before the reset, also verify
   no `ai.lody.mobile.e2ee.kek.v1` Keychain item or `LodyE2eeCustody` receipt remains.
   Sign in and open the workspace again. Check OneSignal has
   no previous external user binding, including after an offline reset/relaunch.
3. Block the entry bundle and let the 12-second inline watchdog fire. Confirm
   “Reset app data” is visible after the splash hides and works without React.
4. Delete `window.__LODY_NATIVE_RESET__`, then separately replace its method with
   `() => Promise.reject(new Error('test rejection'))`. On each run use the public
   recovery action and verify web-wipe fallback signs out. Also force native
   record verification failure in a debug build; the cover must disappear and
   the fresh root must perform the shared web wipe before importing the app.
5. Install/use a build older than 0.20.3 (2026-09-27), upgrade in place, and open a
   workspace. If stuck, preserve copied diagnostics and the existing PostHog
   workspace/boot_wait_stuck event before trying reset. Verify post-reset sign-in.

6. Put an unrelated cookie in `HTTPCookieStorage.shared` from a native debug hook
   (and recreate it after removal to model another SDK). Trigger a failed native
   reset and relaunch. Shared-cookie presence must not block `getResetResult` or
   app startup. Separately force credential deletion failure: three consecutive
   boots reject, the fourth still runs the Web wipe before importing the app and
   exposes the degraded flag; do not assert sign-out with undeletable credentials.
7. Verify `__LODY_APP_INFO__.last_native_reset_outcome` on success/fallback and after
   another launch, including with no install ID. Check copied boot diagnostics and
   `mobile/boot_failed` include the result when startup fails. Preserve the existing
   `workspace/boot_wait_stuck` event and copied diagnostics during the old-version
   upgrade case above.

Do not claim the device, Keychain-scope, push binding, or upgrade checks passed
from the JS tests alone. Native compilation requires macOS/Xcode.
