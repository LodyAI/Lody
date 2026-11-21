# Android native E2EE custody (B1)

Rebased private baseline: `13cd664e0` (2026-10-30). The feature does not
change its pinned OSS gitlink. Approved public contract audit: `e52ce6d3b29f822c40270db7cada87d610996917`.
[Approved product scope](../../specs/e2ee/client-custody.md).
The native wrapping format follows A0 #2038 (`specs/e2ee/client-custody.md`).
The approved public custody/host contracts are adopted. The
[native adapter](e2ee-native-adapter.md) supplies their custody Layer; application
[entry](e2ee-runtime.md) composes the portable host. Installed-app and physical-device
acceptance remain distinct from adapter tests. No OSS gitlink changes.

## Bridge and installation

`LodyKek` exposes `install`, `status`, `wrap`, `unwrap`, `delete` promises, all
scoped to `accountId`, `workspaceId`, `genesisHash`, `deviceId`, `installationId`.
Account/workspace are nonempty UTF-8, <=256 bytes, without NUL; the other three
fields follow the strict hex binding format below. The host owns authorization
and must durably save its pending identity and random installationId **before**
installing. A native `ready` response does not grant approval or resolve a
missing/unknown host DB record. Preserve pending originals and require desktop
reapproval when the host cannot reconcile its installation.

`wrap` accepts `purpose` and base64 `plaintext` (0..4096 bytes); `unwrap` accepts
`purpose` and base64 `wrapped`. Output is base64 `wrapped` / `plaintext`.
The complete closed purposes are `signing-private-key`, `encryption-private-key`,
`device-credential`, `installed-epoch-key`, `rotation-candidate`.
The unqualified old `epoch-key` and internal `installation-probe` are rejected.

A0 wrapping v1 is `0x01 || nonce[12] || ciphertext || tag[16]` (29-byte overhead,
so 32-byte input produces 61 bytes). AAD is canonical DAG-CBOR of
`["lody-e2ee/client-custody/v1\0", 1, accountId, workspaceId, genesis, device, installationId, purpose]`.
The NUL is one byte; genesis/device are **32-byte CBOR byte strings**, not text.
For the JSON bridge, `genesisHash` and `deviceId` carry their lowercase 64-digit
hex representations: `deviceId` means the expected **signing public key**, never
a display/device identifier. `installationId` is also lowercase hex of 32 secure
random bytes, durably retained by the host. Native code validates and decodes these
fields itself, builds the fixed canonical array and rejects unknown versions,
malformed lengths and noncanonical hex. The host never supplies arbitrary AAD.
This is local wrapping, not a new ledger/content wire protocol. Caller nonces and
KEK export remain unavailable.

The native installation probe uses a distinct private AAD domain
`lody-e2ee/client-custody/probe/v1\0`; it is not an additional public purpose.
Prior experimental unversioned wrappers/probes are refused without rewriting,
regenerating keys or falling back to the old AAD. Originals remain untouched.

`install` returns `{state: 'ready', version: 1, installationId}`; `status` uses
state `missing` only when both marker and key are absent, otherwise `ready` after
actual readback/probe. Missing never authorizes creation;
`delete` returns `{state: 'deleted'}` only after verifying key absence.
Failures use fixed codes only: `INVALID_REQUEST`, `LOCKED`,
`PROTECTION_UNAVAILABLE`, `REAPPROVAL_REQUIRED`, `INSTALLATION_UNKNOWN`,
`AUTHENTICATION_FAILED`. No raw OS errors or caller material go into logs;
Capacitor bridge argument/result logging is disabled, including debug shells.

Installation is add-only (a settled exact retry revalidates its retained key/probe): persist pending receipt -> generate Keystore key ->
readback and encrypt/decrypt probe -> persist ready receipt -> verify readback.
Missing receipts, mismatched scope/install, wrong/missing keys, corruption, and
uncertain writes block use. No lookup implicitly creates or replaces a key. Pending/missing-half installs remain refused;
an exact ready retry does not rewrite its key, probe or originals.
Deletion persists a tombstone first; retry deletes only that scope. Desktop
reapproval uses a new device identity. Host DB/journal cleanup remains B3 work. Missing marker with a residual key
refuses deletion; malformed/wrong-incarnation markers cannot authorize cleanup.

## API and platform policy

- Minimum Android API **24**, unchanged. All native calls require the default
  **credential-encrypted** context and `UserManager.isUserUnlocked()`. No device-
  protected context or direct-boot component is added. The CE receipt is required
  on every operation. CE storage stays available after first unlock until reboot,
  including later screen locks. This is not per-operation biometric auth.
- KEK is generated inside `AndroidKeyStore`: AES-256, GCM, no padding,
  randomized encryption required, encrypt/decrypt only, no per-use auth. Each
  read verifies KeyInfo algorithm/size/origin/purposes/modes/padding and rejects
  a key with exportable bytes. There is no application-software KEK fallback.
- No `setUnlockedDeviceRequired(true)`: that means currently unlocked, a different
  policy, and has documented issues on Android 12–14. The native bridge's CE +
  user-unlocked gate implements after-first-unlock availability. It does not
  claim hardware-enforced first-unlock policy on the key itself.
- Keystore exceptions map to locked / reapproval / protection unavailable; no
  ordinary Preferences key storage. Software-backed Keystore is not claimed to
  be TEE/StrongBox. Actual hardware security remains device acceptance evidence.
- Receipts use `getNoBackupFilesDir()` + `AtomicFile` with file sync. Manifest
  disables backup; API 24 backup and API 31+ data-extraction rules exclude all
  app storage from both cloud backup and device transfer, including WebView DB
  and journals. Native Keystore key material is never an app backup file.

Sources: [Direct Boot/CE semantics](https://developer.android.com/privacy-and-security/direct-boot),
[Keystore](https://developer.android.com/privacy-and-security/keystore),
[backup rules](https://developer.android.com/identity/data/autobackup),
[unlocked-device-required policy](<https://developer.android.com/reference/android/security/keystore/KeyProtection.Builder#setUnlockedDeviceRequired(boolean)>).

## Validation and remaining gates

`JAVA_HOME=<JDK> pnpm --filter @lody/mobile-capacitor test:kek:android` exercises the real
Java custody state machine using injected in-memory storage and desktop JCE,
including failure cut points and JS WebCrypto interop in both directions. It
never accesses AndroidKeyStore or user keys. Set `LODY_REQUIRE_ANDROID_KEK_TESTS=1`
to fail instead of skipping when the JDK is absent. Optional `ANDROID_API24_JAR`
and `ANDROID_CURRENT_JAR` compile the production storage adapter against official
minimum/current headers.

Locally completed: native state-machine assertions and bidirectional WebCrypto
interop; the production storage adapter compiled against official API 24 and
API 36 headers; the real Capacitor Android app passed
`compileDebugJavaWithJavac` with JDK 21, compile SDK 36, min SDK 24 (including
resource/manifest processing). Web assets came from the same P baseline build.
`pnpm check:affected` and repository formatting also passed. No VM was started.

The shared fixture is copied **byte for byte** from public A0 #2038, source SHA
`e1e3b5a10f65d94655d097cd262f008a35c2688e`, path
`packages/e2ee-core/test/client-custody-vector.json`, to
`tests/fixtures/client-custody-vector.json`. SHA-256:
`df29e783c922c419e195f53351526975f390c9ed2bf448b9089c67275e4c597c`.
The runner pins these bytes; it never regenerates expected AAD or ciphertext.
Both native suites compare all five AADs and full fixed-nonce wrappers bytewise,
unwrap the original blobs, and compare real random-nonce wrap output against the
fixture binding/key/payload. Tag/version tampering is rejected. JVM input is a
lossless TSV projection of this same JSON, not independently generated vectors.
Fixed nonces apply only to synthetic CryptoKit/JCE test keys. Production nonce
creation and the five-method native bridge are unchanged; the KEK is not exported.

Use `node scripts/test-kek-ios.mjs --unit-only` or
`JAVA_HOME=<JDK> node scripts/test-kek-android.mjs --unit-only` for the current
memory-limited gate. It omits adapter compilation and full App builds. Full App
compilation and `check:affected` for the new fixture change are explicitly deferred
by the coordinator; prior full-build/check evidence refers to the preceding head.

Pending: installed emulator API probe and process reopen (V1/L0,
scheduled only); real minimum OS and hardware device; first unlock after reboot,
Keystore invalidation, backup/reinstall and B3 cleanup. JVM tests and successful
compilation do not prove any of those native behaviors.

## Approved A0 / A5 audit and B2 handoff (2026-10-30)

Sources: public main `e52ce6d3b29f822c40270db7cada87d610996917`, approved
`specs/e2ee/client-custody.md`, `packages/e2ee-client/README.md`, and
`packages/e2ee-core/src/services/client-custody.ts`. The frozen vector bytes match
that main exactly; format/domain/purposes did not change after initial review.

| Boundary                 | Audit and correction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Platform protection      | iOS adds/reads `AfterFirstUnlockThisDeviceOnly`, non-synchronizing data-protection Keychain. KEK is native-readable, never exported by the bridge; no Secure Enclave claim. Android generates inside AndroidKeyStore, checks non-exportability and KeyInfo, requires CE storage and user-unlocked state; no per-use auth, DE context, Preferences KEK or hardware claim. Actual native attributes/first-unlock remain scheduled acceptance.                                                                  |
| A0 v1 wrapping           | Same five purposes, version byte, canonical text/byte-string AAD and frozen vector bytes. The native 4096-byte material limit is explicit; larger inputs fail closed and preserve originals.                                                                                                                                                                                                                                                                                                                 |
| Install reconciliation   | Fixed: a fully settled same-binding retry re-reads the retained key/probe and changes nothing. Pending, corrupt or missing halves never regenerate an identity.                                                                                                                                                                                                                                                                                                                                              |
| Availability             | Fixed: fresh absence is observable as `missing`; residual state still fails. Native `ready` maps only to public custody `available`, never host installation-ready, login or device approval.                                                                                                                                                                                                                                                                                                                |
| Scoped deletion          | Fixed: absent marker plus a residual key refuses deletion. Require marker version/scope/incarnation before writing a tombstone. Old deletion spares a fresh replacement and other accounts.                                                                                                                                                                                                                                                                                                                  |
| Actual native settlement | Fixed: per-account/workspace/genesis call queues replace global serialization. Replacement identities share the old physical route; independent routes progress. Android dispatches off Capacitor's handler. Admitted closures own their inputs and callback until actual return; there is no native cancellation, timeout or forced lock release.                                                                                                                                                           |
| Promise / Effect bridge  | B2 must capture the complete binding and native method references, map fixed errors without raw messages, and join native promises uninterruptibly. A cancelled waiter is not a cancelled OS call. Do not use `Promise.race` as a substitute for settlement or reissue unknown calls.                                                                                                                                                                                                                        |
| Secret cleanup           | B2 must acquire every unwrap result atomically with cleanup registration (`Effect.acquireRelease` / `acquireUseRelease`). Copies made before executor entry need immediate cleanup ownership, release if rejected before entry, and one transfer to the entered program. Never clear a borrowed buffer while native work is pending; native completion alone is not cleanup registration.                                                                                                                    |
| A5 close / injection     | Supply real resource-owning `PersonalHostPlatform.custody` Layers (`ClientKeyCustody` + `ClientIdentityOriginals`), writer and durable stores to `makePersonalWorkspaceRuntime`. It uses the owned host. Five seconds is only a waiter budget: retain the whole `close-incomplete` failure and its owner/dependencies. `owner.settled()` includes failed drains; only successful `owner.awaitSettled()`/confirmed close permits handoff.                                                                     |
| Originals / replacement  | This raw protector is not a complete custody Layer: B2 must durably retain wrapping intent and first exact ciphertext before publication, implement original lookup, and refuse unresolved outcomes. Retry retained blobs instead of re-wrapping. After fresh desktop approval and actual old-owner drain, use public `ClientInstallationStore.replace` to atomically archive/switch; never change identity via native install, reset a namespace, delete old journals, or infer approval from availability. |

The new native queue tests block an admitted call with explicit signals, prove an
independent route completes while a same-route replacement waits, and prove late
settlement preserves order. JVM also cancels its observer. These tests establish
application queue ownership, not behavior of a globally stalled OS service, the
A5 product runtime, or a destroyed/reinstalled WebView. B2 product composition is
not enabled or claimed here; full host/lifecycle acceptance remains separate.

This round runs native unit tests and private `check:affected`, serially with one
Node test-file worker; normal pre-push remains enabled. Full Xcode/Gradle App
builds and all stack/VM/simulator work are deferred by the coordinator.

Scheduling estimates (not measurements of the new head): allow 3–8 minutes and
2–4 GiB for a serial Xcode build, 2–5 minutes and 1–2 GiB for Gradle with one
worker. If fresh web assets are required, reserve a separate 2–5 minute slot and
roughly 6–10 GiB; the earlier Vite build needed a larger-than-default Node heap.
Native builds should reuse those assets and run one platform at a time. Installed
simulator probes need a separate V1 slot per platform and explicit scheduling.
