# E2EE recovery vault desktop integration

Status: proposed
Translation: current

[中文](2026-10-30-e2ee-recovery-vault-desktop.zh.md)

## Abstract

The core implements vault-v1 recovery but no product surface uses it, so a user who
loses every paired device loses their encrypted workspaces. This note proposes a
default-off desktop integration that uses only the recovery file: create an account
vault, set up per-workspace Recovery devices, and restore from the file. Electron 44
on macOS cannot return a WebAuthn PRF result, so PRF is deferred. Restoring end to
end also needs a private-backend authentication path for Recovery devices, which this
repository cannot provide. Nothing here has been tested on a real device.

## Problem

The MVP asks users to pair at least two devices. The [recovery vault Spec](../../../../specs/e2ee/recovery-vault.md)
covers the remaining case, but only `packages/e2ee-core` and the Lab consume it. The
desktop has no production `RecoveryVaultStore` or `RecoveryVaultLocalStore` adapter,
no Convex calls for the declared `e2eeRecoveryVault` functions, and no UI. The
[open contracts note](../architecture/2026-10-15-e2ee-open-contracts.md) lists the
vault as implemented in core only.

## Proposal

- **Gate.** The main process exposes recovery IPC only when `LODY_E2EE_RECOVERY_VAULT=1`.
  The renderer additionally requires developer mode plus a default-off setting. With
  either gate off, no vault, ceremony, network or storage work runs.
- **Vault per account.** One vault and one recovery file per account. The core index
  already holds many workspace entries, so a user keeps one file instead of one per
  workspace. The main process writes the file through a native save dialog, so the
  unlock secret never reaches the renderer.
- **Local journal.** A SQLite `RecoveryVaultLocalStore` lives in the account's E2EE
  directory. It holds only encrypted entries, original signed records and non-secret
  progress, as the core requires.
- **Service.** The Convex `RecoveryVaultStore` calls `api.e2eeRecoveryVault.*` and
  decodes its replies with the `@lody/e2ee-core/host` DTOs.
- **Minimal first loop.** Create the vault and save its file, then reopen the vault from
  that file and decrypt its index. This proves the file unlocks the vault through the
  real service. Workspace setup and restore follow once Recovery devices can authenticate.

## Platform findings: WebAuthn PRF on macOS

Research on 2026-10-30, from public sources. Nothing was measured on a device.

| Path | PRF result | Requirements | Source |
| --- | --- | --- | --- |
| Electron Touch ID authenticator (`app.configureWebAuthn`, 41.5+) | None: Chromium's Touch ID authenticator never sets `supports_prf` | `keychain-access-groups`; credentials stay on one device | [electron#51255](https://github.com/electron/electron/pull/51255) |
| Electron `platformPasskeys` (iCloud Keychain) | Ignored: Electron's docs say PRF inputs are ignored | Electron 45 only; associated domains, embedded profile, AASA | [electron#51563](https://github.com/electron/electron/pull/51563) |
| Chromium's own iCloud Keychain authenticator | Yes, on macOS 15+ | Browser-only entitlement, which Apple grants only to real web browsers | [Chromium CL](https://chromium.googlesource.com/chromium/src/+/7fe5155fed538b1d2317c516ddc633ee7fa206ef%5E%21) |
| Native AuthenticationServices module (e.g. `vault12/electron-webauthn-mac`) | Yes, macOS 15+, 32-byte output | `webcredentials:` associated domain, application identifier, embedded profile, AASA | [Apple docs](https://developer.apple.com/documentation/authenticationservices/asauthorizationpublickeycredentialprfassertioninput-swift.struct), [module](https://github.com/vault12/electron-webauthn-mac) |
| System-browser ceremony on the RP's https domain | Yes, in Safari 18 and Chrome 132+ | Hands the result back to the app; the RP web origin joins the trust base | Analysis |

Lody pins Electron 44.9.3. WebAuthn also needs an https origin whose registrable
domain matches the RP ID, so a `file://` or custom-scheme renderer cannot call it at all.
Developer ID builds can use Associated Domains, but no end-to-end report confirms it.

## Alternatives

**PRF route.**

- *Native module (recommended next).* It keeps the ceremony inside the app and can
  report the real PRF result, which the core validates through `verifiedPasskeyPrf`.
  Costs: macOS 15+ only, an RP domain serving AASA, a provisioning profile in the
  packaged app, and a native dependency to review.
- *System browser.* No native code. However, the raw PRF output, or a key derived from
  it, passes through RP-served JavaScript and a local handoff. A local process can race
  a loopback port or URL scheme. Mitigation is an HPKE-sealed handoff to an ephemeral
  app key, plus a short confirmation code. The RP server still stays in the trust base.
- *Patch Electron.* Wiring PRF into Electron's platform passkey authenticator looks
  small, but it forks the runtime or waits on upstream.
- *No PRF.* The recovery file alone is enough for the first release.

**How R authenticates to the service.**

- *Derive R's access credential (recommended).* Use HKDF over R's signing private key
  with a new domain, and register its hash on R's admission append through the existing
  `credentialHash` field. The approved package format stays unchanged, but the private
  backend must accept that hash for a Recovery-kind admission.
- *Signature challenge for Recovery devices.* This needs a new backend route.
- *Store a credential inside the package.* Rejected: it changes the approved
  `formatVersion: 1` field set.

**Retaining V on a desktop.**

- *Wrap V with OS custody.* Setup on new workspaces and per-epoch tests then run
  without the file. The device already holds those workspaces' keys, but V also
  unlocks every other entry in the vault.
- *Require the file each time.* Safer at rest, but stale tests become likely.

## Consequences and limits

All proposed capabilities are default-off and leave current pairing, ledger and
workspace behavior unchanged. Two things are unverified: whether the private backend
has deployed the `e2eeRecoveryVault` functions, and whether it can authenticate Recovery
devices. The owner decisions are listed in the Spec's integration section.
