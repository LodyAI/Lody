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

## Consequences and limits

All capabilities stay default-off and leave pairing, ledger and workspace behavior
unchanged. Several things remain unverified:

- whether the macOS and Windows user-presence mechanisms behave on real devices;
- whether the native module and associated domain work in a Developer ID build;
- whether the whole-vault replacement flow and its 16-retired-vault limit behave as specified;
- the backend work listed above.

The owner approved the R credential parameters with the Spec revision.
