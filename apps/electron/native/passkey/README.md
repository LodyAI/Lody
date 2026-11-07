# Passkey bridge

AuthenticationServices passkey ceremonies with PRF, for the [recovery vault](../../../../specs/e2ee/recovery-vault.md#passkey-unlock).
The main process calls it through `src/main/services/e2ee-passkey-macos.mts`. Without the built
addon, or below macOS 15, the port reports unavailable, so ordinary builds are unaffected.

**This code has never been compiled or run.** It was written on Linux from Apple's headers as
mirrored by public bindings. The first Mac build may need fixes.

## Build

On macOS, from this directory, against the app's Electron version:

```sh
npx node-gyp rebuild --target=44.9.3 --arch=arm64 --dist-url=https://electronjs.org/headers
```

## Packaging the cloud desktop

The cloud build owns these, because the public build has no vault:

- Ship `build/Release/passkey_bridge.node` to `Contents/Resources/passkey_bridge.node`, signed by
  the same team. The main app keeps library validation.
- Add to the main app's entitlements only, never the inherit plist:
  `com.apple.developer.associated-domains` with `webcredentials:vault.lody.ai`,
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
