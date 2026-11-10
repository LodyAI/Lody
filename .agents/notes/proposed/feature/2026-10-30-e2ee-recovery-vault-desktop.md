# E2EE recovery vault desktop integration

Status: proposed
Translation: current

[中文](2026-10-30-e2ee-recovery-vault-desktop.zh.md)

## Abstract

The core implements vault-v1 recovery, but no product uses it. A user who loses every
paired device therefore loses their encrypted workspaces. On 2026-10-31 the owner decided
the six integration questions, relayed by the E2EE coordinator:

- one vault per account;
- V may stay on a desktop only behind per-use user presence;
- R authenticates with an HKDF-derived credential registered through `credentialHash`;
- PRF uses a native macOS module;
- the RFC 8410 PKCS#8 package rule is accepted;
- a successful restore notifies the user's devices and email, with no extra gates.

The owner approved the [Spec](../../../../specs/e2ee/recovery-vault.md) revision recording these
on 2026-10-31. On 2026-11-06 the owner approved a [revision](../../implemented/architecture/2026-10-28-e2ee-spec-approval.md#recovery-vault-passkey-unlock-and-trust-anchor)
that adds iPhone and Web passkey unlock, admits any passkey returning a real PRF result,
and makes the authenticated package's genesis the trust anchor. It supersedes decision 4's
macOS-only scope and the independent confirmation.

On 2026-11-06 the owner also approved [whole-vault replacement](../../implemented/architecture/2026-10-28-e2ee-spec-approval.md#recovery-vault-whole-vault-replacement)
for a lost or leaked recovery file. It keeps one current vault and one recovery file,
allows one temporary `replacing` vault, and caps retired vaults at 16. It adds to, rather
than replaces, the six decisions above. Nothing here has been tested on a real device.

## Problem

The MVP asks users to pair at least two devices. The vault covers the case where no
device survives, but only `packages/e2ee-core` and the Lab consume it. The
[open contracts note](../architecture/2026-10-15-e2ee-open-contracts.md) lists the vault
as implemented in core only. [#2125](https://github.com/LodyAI/Lody/pull/2125) adds a
default-off desktop loop: create the account vault and its file, then check a file. It
neither retains V nor admits R, so decisions 2 and 3 apply only to later work.

## Decisions and rejected options

**1. Vault scope: one per account.** The core index already holds many workspace entries.
The [whole-vault replacement revision](../../implemented/architecture/2026-10-28-e2ee-spec-approval.md#recovery-vault-whole-vault-replacement)
keeps one `current` vault and one recovery file, permits one temporary `replacing` vault,
and caps retired vaults at 16.

- _Rejected: one vault per workspace._ The user would have to keep a file per workspace, and
  each new workspace would need a new offline backup.

**2. Retaining V: allowed, but only behind per-use user presence.**

- macOS uses a Keychain item with user-presence access control (Touch ID or the account
  password). Windows uses Windows Hello or a credential prompt.
- This is a deliberate exception, for V alone, to the per-device rule that keys need no
  per-use approval (see the [client custody Spec](../../../../specs/e2ee/client-custody.md)).
- Where the platform cannot enforce presence, the app asks for the file each time.
- _Rejected: silent retention._ A compromised or borrowed unlocked device could then open
  every vault entry without the user.
- _Rejected: always requiring the file._ Per-epoch tests would go stale and new-workspace
  setup would need the offline file.

**3. Recovery-device authentication: an HKDF-derived credential.**

- The credential is HKDF-SHA256 over R's Ed25519 seed. Salt is the genesis hash; info is
  `lody-e2ee/recovery-credential/v1\0` followed by R's public key.
- Its SHA-256 is registered through the existing `credentialHash` field on R's admission
  append.
- _Rejected: storing a credential inside the package._ That changes the approved
  `formatVersion: 1` field set.
- _Rejected: a signature-challenge route._ It adds a new authentication protocol to the
  backend, where the derived credential reuses the existing device-credential path.

**4. PRF: native macOS AuthenticationServices, macOS 15+.**

- Prerequisites: a Lody RP domain serving an apple-app-site-association (AASA) file, the
  `webcredentials:` entitlement, an embedded provisioning profile, and native dependency
  review.
- Only a real ceremony counts: PRF `enabled: true` with a 32-byte `results.first`. There is
  no fallback.
- _Rejected: a system-browser ceremony._ RP-served JavaScript and the local handoff would
  join the trust base, and a loopback port or URL scheme can be raced.
- _Rejected: patching Electron._ That means forking the runtime or waiting on upstream.
- _Rejected: Electron's built-in authenticators._ They return no PRF (findings below).

**5. Package private keys: exact 48-byte RFC 8410 PKCS#8.** Implemented in
[#2124](https://github.com/LodyAI/Lody/pull/2124).

**6. After a restore: notify every active device of the account and the account email.**

- _Rejected: forced R replacement, owner approval and a cooldown._ The owner chose recovery
  availability. Replacement and revocation remain explicit user actions.
- The notification is informational. A hostile service can suppress it, while the R-signed
  admission stays visible in the verified ledger.

## Backend gap

As inspected on 2026-11-05, the private backend implements vault storage, the Recovery
credential hash, R-authenticated mailbox read and R's admission append behind a
default-off switch. Two gaps gate real-service use:

- R's read of committed staged envelopes;
- the restore notification.

## Platform findings: WebAuthn PRF on macOS

Research on 2026-10-30 from public sources; nothing was measured on a device. Lody
pins Electron 44.9.3.

| Path                                    | PRF result                      | Requirements                                                      | Source                                                                                                                                                                                                                             |
| --------------------------------------- | ------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron Touch ID authenticator (41.5+) | None (`supports_prf` never set) | `keychain-access-groups`; device-bound                            | [electron#51255](https://github.com/electron/electron/pull/51255)                                                                                                                                                                  |
| Electron `platformPasskeys` (45 only)   | PRF inputs ignored              | Associated domains, embedded profile, AASA                        | [electron#51563](https://github.com/electron/electron/pull/51563)                                                                                                                                                                  |
| Chromium iCloud Keychain authenticator  | Yes, macOS 15+                  | Browser-only entitlement                                          | [Chromium CL](https://chromium.googlesource.com/chromium/src/+/7fe5155fed538b1d2317c516ddc633ee7fa206ef%5E%21)                                                                                                                     |
| Native AuthenticationServices (chosen)  | Yes, macOS 15+, 32 bytes        | `webcredentials:`, application identifier, embedded profile, AASA | [Apple docs](https://developer.apple.com/documentation/authenticationservices/asauthorizationpublickeycredentialprfassertioninput-swift.struct), [vault12/electron-webauthn-mac](https://github.com/vault12/electron-webauthn-mac) |
| System browser on the RP domain         | Yes (Safari 18, Chrome 132+)    | Handoff back to the app                                           | Analysis                                                                                                                                                                                                                           |

A `file://` or custom-scheme renderer cannot call WebAuthn at all. Associated Domains
is listed for Developer ID apps, but no end-to-end report confirms that it works.

## Feasibility spike: Developer ID, AuthenticationServices and PRF

Static part, 2026-11-07, on Linux. Nothing was built, signed or run on a Mac, so feasibility
stays unproven. Public sources do not settle it: Apple's [entitlement reference](https://developer.apple.com/tutorials/data/documentation/bundleresources/entitlements/com.apple.developer.associated-domains.md)
and [passkey guide](https://developer.apple.com/documentation/authenticationservices/supporting-passkeys.md)
do not discuss Developer ID. [TeamDev's guide](https://teamdev.com/mobrowser/tutorials/features/touch-id/)
embeds a Developer ID profile for a Chromium app, but for Touch ID keychain groups, not
`webcredentials`. [Clerk](https://clerk.com/docs/reference/electron/passkeys) and
[electron-webauthn-mac](https://awesome.ecosyste.ms/projects/github.com%2Fvault12%2Felectron-webauthn-mac)
describe development signing only.

What the repository shows:

- The cloud desktop is `ai.lody.desktop` in the private `apps/electron-cloud/electron-builder.yml`.
  `dev.loro.lody.oss` is the local-only public build, which has no vault, so the checks below
  apply to the cloud build. iOS is `ai.lody.mobile`.
- `apps/electron/electron-builder.yml` uses the hardened runtime and notarization, with
  `entitlements` for the app and `entitlementsInherit` for nested binaries.
- `build/entitlements.mac.plist` has no `com.apple.developer.associated-domains`,
  `com.apple.application-identifier` or `com.apple.developer.team-identifier`, and no profile
  is embedded. All three are needed. They belong on the main app only, never in the inherit
  plist.
- The main app keeps library validation, so the native addon must be signed by the same
  team. The existing `electron-sparkle-updater` native addon is the packaging precedent.

Whether electron-builder's `mac.provisioningProfile` embeds a Developer ID profile, and whether
Sparkle updates keep it valid, must be confirmed on the first signed build.

Run these in order on a Mac. Stop at the first failure.

1. **Signing.** Build with the profile and new entitlements. `codesign -d --entitlements - Lody.app`
   lists the three keys, `spctl -a -vv Lody.app` accepts it, and it launches after notarization.
   A launch failure here is the main risk.
2. **Association.** `curl https://app-site-association.cdn-apple.com/a/v1/lody.ai` returns
   the file, and `sudo swcutil show` lists the app against the domain.
3. **Ceremony.** A minimal addon creates a platform passkey for `lody.ai` with a PRF
   input, anchored to the `BrowserWindow`. The system sheet names the RP, and registration
   reports PRF support.
4. **PRF.** Assertion returns 32 bytes, the same bytes on a second assertion and on a second
   Mac through iCloud Keychain.
5. **Update.** A Sparkle update from one signed build to the next keeps steps 2 to 4 working.

If step 1 or 2 fails, Developer ID cannot carry this path. The fallback is the recovery file on
macOS, with passkeys only on iPhone and the Web surface, which needs an owner decision.

## Same-origin Web recovery revision

Owner's 2026-11-10 direction supersedes the dedicated-host plan: recovery runs in the
ordinary `lody.ai` client, with RP `lody.ai`, no device C, cross-page channel or manual
copy fallback. This expands ceremony trust to the parent domain and subdomains,
including marketing/analytics code. System verification remains required. The
[revised Spec](../../../../specs/e2ee/recovery-vault.md#passkey-unlock) was approved by zxch3n on 2026-11-10; this does not enable rollout.
Temporary plaintext is wiped after settlement; encrypted journals remain durable.
Existing application ownership is reused: setup borrows only its own reader and
restore uses the same retained device identity. Failure must not close content readers.

## Consequences and limits

All capabilities stay default-off and leave pairing, ledger and workspace behavior
unchanged. Several things remain unverified:

- whether the macOS and Windows user-presence mechanisms behave on real devices;
- whether the native module and associated domain work in a Developer ID build;
- whether the whole-vault replacement flow and its 16-retired-vault limit behave as specified;
- the backend work listed above.

The owner approved the R credential parameters with the Spec revision.

## Browser recovery trade-offs

PRF plus a recovery file remains the owner-approved choice from 2026-11-09.
The 2026-11-10 same-origin direction trades dedicated-host isolation for direct
in-app use. Password plus Secret Key would still require a complete KDF/wrapping
review; a short password alone adds offline guessing exposure.

The following was checked in official public sources on 2026-11-10. This is not
reverse engineering, device testing or an independent security audit. Implications
for Lody are design judgments:

| Product | Verified mechanism and source | Implication for Lody |
| --- | --- | --- |
| 1Password password plus Secret Key path | Its [SRP explanation](https://1password.com/blog/developers-how-we-use-srp-and-you-can-too) distinguishes two-secret derivation from authentication without transmitting the password. Its [Secret Key guide](https://support.1password.com/secret-key-security/) explains strengthening protection of server ciphertext with a random secret. | Borrow local unlocking, without claiming an equivalent model from merely adding a password field. This proposal does not migrate Lody authentication to SRP. |
| Proton Pass | Its [security model](https://proton.me/blog/proton-pass-security-model) describes SRP authentication, password/bcrypt protection of the user key, then vault/item keys. | Layered client decryption can work in browsers; its password wrapper does not establish compatibility with Lody recovery formats. |
| MetaMask Extension seed-phrase path | Its [passkey guide](https://support.metamask.io/configure/wallet/passkeys/) describes a password-protected local vault and passkey wrapping of the local encryption key. Syncing a passkey does not transfer that vault to another installation. Here SRP means Secret Recovery Phrase, not Secure Remote Password. | An extension-local vault does not establish ordinary website recovery of cloud workspace keys. No inference about its social-login path. |
| WhatsApp Web linked devices | Its [multi-device architecture](https://engineering.fb.com/2021/07/14/security/whatsapp-multi-device/) describes independent identities, phone QR linking and independent operation afterward. This is a 2021 architecture source. | Keep device approval as an alternative; it does not supply first unlock without another device. No claim that every current flow is unchanged. |
| WebAuthn PRF | The [W3C specification](https://www.w3.org/TR/webauthn-3/#prf-extension) defines per-credential 32-byte pseudorandom outputs usable for encryption. | A normal passkey signature is not a decryption key. Verify actual PRF rather than a browser name. |

**Ownership and supersession.** This existing proposed note retains the shared native
and recovery rationale; only its Web plan is superseded. Historical approval records
remain unchanged. No implemented note is fully replaced.

**Evidence limits.** This work inspected public Specs,
`packages/e2ee-core/src/internal/recovery/crypto.ts` and the fixed-vector location.
No unlock or pairing was executed, and neither private deployment nor the Ryugi
artboard was verified. Earlier product-integration, PR-state and platform-gap
statements above are historical inspections, not current facts established here.

### Portable recovery host boundary

The explicit restore command owns one prepared identity and its recovered-key Scope.
It authenticates the package/account before preparation, retains original admission,
then uses a verified admitted session to install keys. Cancellation/close follows the
existing owned host drain; no new background owner or replacement path is added.
Installation failure preserves identity and original for retry; independent bindings
and already admitted content remain usable. Chromium tests cover bad packages,
wrong accounts, revoked R, failed installation, exact retry and persistent reopen.
The private Web entry and deployment remain separate acceptance.
