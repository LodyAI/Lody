# Passkey bridge

AuthenticationServices passkey ceremonies with PRF, for the [recovery vault](../../../../specs/e2ee/recovery-vault.md#passkey-unlock).
The main process calls it through `src/main/services/e2ee-passkey-macos.mts`. Without the built
addon, or below macOS 15, the port reports unavailable, so ordinary builds are unaffected.

It builds with Xcode 27.2 for Electron 44.9.3 on arm64.
**No signed build or real ceremony has exercised it.** Synthetic native checks cover input
validation, unexpected credential types, and PRF erasure at deallocation.

## Build

On macOS, from this directory, against the app's Electron version:

```sh
npx node-gyp rebuild --target=44.9.3 --arch=arm64 --dist-url=https://electronjs.org/headers
```

## Synthetic checks

After building, from the repository root, run the service suite against the real addon:

```sh
LODY_PASSKEY_TEST_ADDON="$PWD/apps/electron/native/passkey/build/Release/passkey_bridge.node" \
  node --import tsx --test apps/electron/src/main/services/e2ee-passkey-macos.test.mjs
```

Without that variable, the native input test is skipped. It never opens a system prompt.
The standalone Objective-C++ test checks wrong-mode/unexpected credentials and observes
PRF bytes just before deallocation, including failed, cancelled and environment-shutdown cleanup.
Use the Electron headers downloaded by node-gyp (adjust the cache path if needed):

```sh
xcrun clang++ -std=c++17 -fobjc-arc -O2 -mmacosx-version-min=12.0 \
  -undefined dynamic_lookup -I "$HOME/Library/Caches/node-gyp/44.9.3/include/node" \
  -framework AppKit -framework AuthenticationServices \
  apps/electron/native/passkey/test/passkey_bridge.test.mm -o /tmp/passkey-bridge-test
/tmp/passkey-bridge-test
```

This test includes the bridge implementation; unused N-API symbols resolve dynamically.
It requires macOS 15+ for the credential checks. Run it with `-O3` as well to check
optimized cleanup. These checks do not establish real-device ceremony acceptance.

## Packaging the cloud desktop

The cloud build owns these, because the public build has no vault:

- Ship `build/Release/passkey_bridge.node` to `Contents/Resources/passkey_bridge.node`, signed by
  the same team. The main app keeps library validation.
- Add to the main app's entitlements only, never the inherit plist:
  `com.apple.developer.associated-domains` with `webcredentials:lody.ai`,
  `com.apple.application-identifier` with `YTRMX32C99.ai.lody.desktop`, and
  `com.apple.developer.team-identifier` with `YTRMX32C99`.
- Embed a Developer ID provisioning profile with Associated Domains for `ai.lody.desktop`.

## Unverified

Run the ordered checks in the [desktop integration note](../../../../.agents/notes/proposed/feature/2026-10-30-e2ee-recovery-vault-desktop.md).
These points in the bridge need a real device:

- whether `excludedCredentials` exists on macOS 15, which decides if a second passkey can enroll;
- the user-verified flag read from `rawAuthenticatorData`;
- window anchoring from `getNativeWindowHandle`;
- a threadsafe settle from the delegate callback on the Electron main thread.
