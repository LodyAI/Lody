# Native E2EE custody (B0)

Rebased private baseline: `13cd664e0` (2026-10-30). The feature does not
change its pinned OSS gitlink. Approved public contract audit: `e52ce6d3b29f822c40270db7cada87d610996917`.
Product authorization: [approved proposal](../../specs/e2ee/client-custody.md).
The native wrapping format follows A0 #2038 (`specs/e2ee/client-custody.md`).
The approved public custody/host contracts are adopted. This low-level bridge
does not enable the mobile host or change the OSS gitlink. Its
[native adapter](e2ee-native-adapter.md) supplies the public custody Layer;
the [application entry](e2ee-runtime.md) composes the portable host. Installed-app
and physical-device acceptance remain distinct from adapter tests.

## Bridge

`LodyKek` exposes `install`, `status`, `wrap`, `unwrap`, `delete`, all promises.
Every call takes `accountId`, `workspaceId`, `genesisHash`, `deviceId`, and
`installationId`. Account/workspace are nonempty UTF-8, <=256 bytes, no NUL;
the three hex fields follow the strict binding format below. These identify
one approved identity installation; they do not authorize it. The public host
must verify authorization and durably save the pending identity and random
installationId **before** `install`, and reconcile the returned receipt with its
own DB before making the identity ready. An unknown/missing DB installation
must not adopt a native ready key merely because `status` succeeds.

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

`install` returns `{state: 'ready', version: 1, installationId}`.
`status` returns the same shape with state `missing` or `ready`: missing requires
both marker and key absence, and never authorizes creation.
`delete` returns `{state: 'deleted'}` after verifying key absence. Failures expose
only fixed codes: `INVALID_REQUEST`, `LOCKED`, `PROTECTION_UNAVAILABLE`,
`REAPPROVAL_REQUIRED`, `INSTALLATION_UNKNOWN`, `AUTHENTICATION_FAILED`.
No raw OS errors, caller material, or keys are logged. Capacitor argument/result
logging must remain disabled, including debug shells.

## iOS

- Keychain generic-password AES KEK: fixed service, SHA-256 of the four identity
  fields as account, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`,
  `kSecAttrSynchronizable=false`, data-protection Keychain, no shared group.
  Each read checks accessibility and key size. The KEK stays within native code;
  unwrapped curve/epoch bytes enter trusted JS memory.
- Fixed Application Support directory holds scope/installation receipts, excluded
  from backup, protected until first user authentication. It is not a cache.
- Installation is add-only (a settled exact retry revalidates its retained key/probe): pending receipt -> create KEK -> readback and actual
  AES-GCM probe -> ready receipt -> readback/probe. Never update an existing KEK.
  Pending/corrupt/mismatched receipts, lost keys and residual Keychain items
  require reconciliation/desktop reapproval, without overwriting old input.
- Deletion persists a tombstone first. Interrupted deletion blocks use; retry
  deletes only that scope. A new approval uses a new device identity; deletion
  never silently reinstalls the old one. App DB/journal cleanup is B3 work. Missing marker with a residual key refuses
  deletion; malformed or wrong-incarnation markers cannot authorize cleanup.
- The user's full native reset is the one unscoped deletion: once WebKit storage (the
  wrapped originals) is gone and admitted calls have returned, it deletes every KEK of
  the fixed service, then the receipt directory. See [native reset](native-reset.md).

References: [Apple accessibility](https://developer.apple.com/documentation/security/ksecattraccessibleafterfirstunlockthisdeviceonly).
ThisDeviceOnly prevents migration to another device; excluding the receipt also
blocks reuse after restoring app data on the same device. iOS may retain
Keychain items after uninstall, so marker absence always blocks their reuse.

## Evidence and remaining gates

`pnpm --filter @lody/mobile-capacitor test:kek:ios` compiles and runs native Swift custody
logic against injected storage, exercises failure cut points, then tests
CryptoKit <-> JS WebCrypto AES-GCM interoperability with synthetic materials.
It also typechecks the real Security adapter on macOS. The full iOS App was
compiled with Xcode 27.1, generic iOS destination and signing disabled (16.4
deployment target); the production web assets and affected local checks passed.
It does not touch the
user's Keychain and does not prove actual iOS persistence or lock semantics.

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

Pending: simulator native API/process-reopen probe (V1/L0 must be
scheduled); packaged app and minimum iOS 16.4 device; real reboot/first unlock,
hardware policy, backup/reinstall, and B3 cleanup. A simulator cannot prove
hardware/real lock semantics. Public adoption alone does not establish mobile
composition or its installed-app acceptance.

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
