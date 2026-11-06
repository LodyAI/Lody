# Recovery vault

Status: draft
Translation: current

[中文](recovery-vault.zh.md)

This draft proposes [passkey unlock](#passkey-unlock-proposed) on macOS, iPhone and
Web and a [trust anchor taken from the package](#trust-anchor-proposed-awaiting-owner-confirmation),
which exceed the [revision approved on 2026-10-31](../../.agents/notes/implemented/architecture/2026-10-28-e2ee-spec-approval.md#recovery-vault-desktop-integration).
It awaits owner approval. Until then, that approved revision stays in force. Passages
about passkeys, the trust anchor and the service gap are the only intended changes;
everything else keeps its approved meaning.

## Approved format boundaries

On 2026-10-28, owner Zixuan Chen (zxch3n) approved only these boundaries, recorded in the [approval note](../../.agents/notes/implemented/architecture/2026-10-28-e2ee-spec-approval.md) ([approval update #2032](https://github.com/LodyAI/Lody/pull/2032)). Recovery admission keeps the existing ledger tag 4 and `lody-e2ee/possess/v2\0` bytes; genesis is unchanged. The encrypted recovery package uses `formatVersion: 1` and contains the recovery generation and trusted ledger material; the trust anchor comes from an authenticated package, as [proposed below](#trust-anchor-proposed-awaiting-owner-confirmation). A source locator or a server response alone does not establish that anchor, and no package proves the latest ledger head.

Before recovery is accepted, import R's keys, replay the ledger from the package's genesis, actually decrypt a current-epoch envelope addressed to R and verify the recovered key against its ledger commitment. The R signature binds the encryption public key but alone does not prove possession of its private key. The package version and these boundaries were approved on 2026-10-28; on 2026-10-31 the owner approved this Spec as a whole ([approval](../../.agents/notes/implemented/architecture/2026-10-28-e2ee-spec-approval.md#recovery-vault-desktop-integration)). The recovery vault remains outside the MVP. The core package carries `formatVersion: 1` and rejects any other or missing version; its private keys must be the exact 48-byte RFC 8410 PKCS#8 encodings for Ed25519 and X25519 (accepted by the owner on 2026-10-31, see the approval note). Approval does not establish deployed or real-device behavior.

## Recovery material and ciphertext

One canonical CBOR `vault-v1` recovery file opens an encrypted vault. Its fixed tuple is
`["vault-v1", 1, vaultId, serviceLocator, U]`: `vaultId` and U are independent random
32-byte values. Generate a separate random 32-byte vault master key V. Derive a
32-byte wrapping key with HKDF-SHA256, salt `vaultId` and the domain
`lody-e2ee/vault-v1/<purpose>\0`; wrap V with XChaCha20-Poly1305. The file is a
vault unlock capability, not a seed from which future workspace identities can be
regenerated. Missing cloud ciphertext cannot be recreated from this file.

Further wrapping entries may wrap the same V, one per passkey, only after real
WebAuthn ceremonies meet the [ceremony contract](#passkey-unlock-proposed): registration
reports PRF `enabled: true`, and an authentication ceremony with user verification
returns a 32-byte `results.first`.
The portable core validates and owns that result; platform adapters authenticate
the ceremony and credential. Ordinary passkey login and a structural object
claiming to be a verified capability cannot unlock the vault. No PRF fallback is
permitted. No hardware ceremony runs automatically while product E2EE is disabled.

Workspace entries and the index use distinct V-derived purpose keys. Every new
encryption requires a fresh host-secure 24-byte nonce; random-source failure stops
it. Each AEAD AAD binds `vault-v1`, vaultId, opaque entryId, revision, predecessor
ciphertext digest and purpose. The outer service header carries only opaque entryId and revision. A separately
authenticated encrypted header hides purpose and predecessor while the inner
AEAD binds the full AAD tuple; both layers use fresh random nonces and separate
HKDF purpose keys. The service never receives workspace identity, roles or keys. Ciphertext
is immutable under its entryId. A recovery package binds genesis, current
membership instance, independent R signing/encryption key pairs, generation and
the origin of trusted genesis/ledger material. The encrypted index binds the same
workspace/member identity and exact package digest. Import verifies both actual
public/private key pairs. A decrypted claim does not establish ledger authority.

## Concurrency and durable setup

Upload an immutable candidate, read it back exactly and decrypt it before CAS of
the encrypted index. CAS includes the expected revision and ciphertext digest,
plus the opaque entry IDs referenced by the proposed index. The same storage
transaction must verify that every referenced immutable entry exists before it
publishes the index; a missing entry returns Conflict. This prevents a concurrent
delete between the client readback and index CAS from publishing a dangling reference;
the successor binds its predecessor. A client pins its highest observed revision
and digest durably and rejects rollback or same-revision equivocation. Valid
AEAD does not prove freshness: a fresh device still depends on the authenticated
service's fresh read plus independently qualified ledger material.

Concurrent first setup for the same workspace/membership uses the winning
index entry's R. A loser rereads and decrypts the winner; it never registers its
own losing candidate. A disjoint-workspace conflict is an explicit merge/retry,
not last-writer-wins. A different generation of the same identity is a visible
replacement, never a silent overwrite.

Setup consists of four resumable steps, not a cross-store transaction:

1. Generate an independent workspace R and unlock V through the file or verified PRF.
2. Encrypt/upload/read back/decrypt its private package; select it through index CAS.
3. The current active personal device signs the public Recovery admission. Persist
   the original signed record and intended position before P09 dispatch; reconcile
   unknown outcomes using these exact bytes. Verify genuine committed membership.
4. Open R's current mailbox or committed staged envelope, check commitment and
   recover the complete signed key-history chain. Save/read back protected keys.

The durable journal retains candidate entryId, encrypted index-CAS intent,
selected entry, original ledger bytes, position and stage. A crash resumes that
identity. Failed candidates cannot be cleaned while any pending intent or current
index still references them. One workspace's progress does not advance another.

Expose paired, current envelope available and recoverable as separate states.
Recoverable requires active ledger R, an actually decryptable R package, trusted
genesis material and a current key whose commitment was checked. Keep last test
time and tested epoch separately; a successful old test does not cover a later
epoch. The user may explicitly skip setup after acknowledging recovery-path loss.

## New-device recovery and retention

A new device decrypts the selected R package, independently verifies the current
ledger and active R, opens the current key envelope and verifies every historical
packet. It generates its own independent personal device C. R signs C's
same-membership personal admission with real proof of possession; persist/retry
that original record through P09 and verify actual committed C. Continue as C and
drop temporary R handles and wipe owned secret byte buffers. WebCrypto exposes no
native-handle zeroization API; adapters must not retain those handles or export
R into a persistent ordinary device store. C inherits the user's current role.
Revoked R cannot admit another device. Historical sender revocation is not
silently relaxed for ordinary mailbox envelopes.

Active packages never expire automatically. Routine replacement verifies the
new package and R before retiring/revoking the old R. Known compromise prioritizes
revocation, even if recovery becomes temporarily unavailable. Retired ciphertext
remains until explicit user cleanup warns that recovery options may be lost.
Deleting cloud ciphertext does not revoke already copied secrets. Failed candidate
entries are retained permanently in this revision: there is no candidate garbage
collection API. A local journal cannot prove that another session has no pending
reference. Explicit risk-confirmed cleanup of retired indexed entries remains a
separate operation and requires an up-to-date index CAS.

## Desktop product integration

On 2026-10-31 the owner decided the six integration questions, relayed by the E2EE
coordinator, and approved this section with the rest of the Spec.
Research, rejected options and evidence are in the [desktop integration note](../../.agents/notes/proposed/feature/2026-10-30-e2ee-recovery-vault-desktop.md).
Nothing here changes MVP behavior: every capability stays behind a default-off
gate, and existing encrypted workspaces, pairing and ledgers behave as before.

**Scenario.** A user who lost every paired device signs in on a new desktop and
uses an offline recovery file to regain their encrypted workspaces. Pairing with a
surviving device remains the primary path; the vault covers the case where no
device survives. Without a vault or a surviving device, that content is lost.

**One vault per account.** An account has one vault and one recovery file; the
vault index holds one entry per workspace membership. Desktop security settings
create the vault and write the file only to a location the user chooses; Lody never
uploads or syncs the file. The user enables recovery per workspace explicitly.
Setup admits that workspace's R through the user's active personal device and runs
the real envelope test. Status is shown per workspace and per epoch; a new epoch
needs a new test.

**V on a desktop requires user presence for every use.** A personal desktop may keep
V only under an OS key whose every use requires the user's presence: on macOS a
Keychain item with user-presence access control (Touch ID or the account password),
on Windows a Windows Hello or credential prompt. This is a deliberate exception,
for V alone, to the rule that personal-device keys need no per-use approval. When
the platform cannot enforce presence, V is not stored and the user selects the
recovery file whenever V is needed. V is never stored silently. Retaining V lets
setup of a new workspace and per-epoch tests run without the file.

**Recovery-device authentication.** R's service access credential is derived with
HKDF-SHA256 from R's 32-byte Ed25519 private seed, salt = genesis hash and info =
`lody-e2ee/recovery-credential/v1\0` followed by R's signing public key. The
personal device registers SHA-256 of the derived credential through the existing
`credentialHash` field when it appends R's admission. On restore the new device
derives the same credential from the decrypted package, uses it for R's mailbox
read and C's admission append, then discards it. The package format is unchanged;
holding R's private key already confers R's ledger authority, so the credential adds
no new capability.

**Restore and notification.** On a device without an identity for a workspace,
"Restore from recovery file" sits next to pairing. It opens the vault, verifies the
ledger from the package's genesis, decrypts R's current-epoch envelope,
checks its commitment, then has R admit a new personal device C. After C's admission
commits, the service notifies every active device of the account and the account
email that workspace X was restored on a new device with the recovery file. There
is no forced R replacement, owner approval or cooldown. The notification informs
the user; it is not a security control, and a hostile service can suppress it.
The R-signed admission remains visible in the verified ledger.

**Passkey PRF.** Desktop passkey support uses a native macOS AuthenticationServices
module, as part of [passkey unlock](#passkey-unlock-proposed). Windows and Linux
desktops use the file.

**Package keys.** The owner accepted the exact 48-byte RFC 8410 PKCS#8 encodings for
both private keys ([#2124](https://github.com/LodyAI/Lody/pull/2124)).

**Service and current gap.** The service stores only opaque immutable entries and
the index CAS declared in `packages/cloud-api`, isolated per account. CAS checks in
the same transaction that every referenced entry exists. As inspected on 2026-11-05,
the private backend implements this storage, R-authenticated mailbox read and R's
admission append behind a default-off switch. It has no R read of committed staged
envelopes and no restore notification. No shipped client calls the storage, and this
repository cannot establish what is deployed. Until those gaps close, the loop cannot
run against the real service.

**Threat model.** Account access controls retrieval and the file controls
decryption. Anyone holding both can read every recovered workspace and admit
devices until R is revoked; the service operator plus the file is equivalent.
The file alone grants nothing without the account's ciphertext. Loss of the file
loses only that recovery path. On a desktop retaining V, malware that can obtain the
user's presence approval can unlock V. The service can withhold or roll back
ciphertext; local pins detect rollback only on a device that saw a newer revision.
Passkey unlock adds the risks listed [below](#passkey-unlock-proposed).

## Passkey unlock (proposed)

**Scenario.** A user who lost every device still has a passkey in iCloud Keychain.
On a new Mac, iPhone or supported browser they sign in, choose "Restore with passkey"
and approve the system prompt. From the moment V is open, the path is the same as the
file path: verify the ledger, open R's envelope, check its commitment, have R admit a
new personal device C, then notify. A passkey opens V for every workspace in the
vault; it never replaces the ledger checks. The scope is backup and restore through R,
the extra account device; the vault adds no other capability.

**Dependencies.** A passkey only wraps V, so it has nothing to unlock until a platform
can run the file-based restore. A passkey cannot ship on a platform before that
restore works there; both are built in parallel, behind default-off gates. The recovery file is
still created with every vault. It remains the fallback when a passkey is lost, the
iCloud account is lost, or the platform has no PRF.

**One RP on a dedicated host.** All platforms share one RP ID so a synced passkey works
everywhere. The RP ID is the dedicated exact host `vault.lody.ai` (owner decision, 2026-11-06), and never
the parent domain or the Web app's own host. A browser lets any page on the RP ID or its
subdomains run a ceremony, so a parent-domain RP would put every subdomain and every
script served from them inside the boundary. The RP ID cannot change later without
orphaning every enrolled passkey. The host serves the apple-app-site-association file
and, if approved, the Web surface below, and nothing else. A future login passkey must
use a different RP, so a login prompt can never unlock V.

**Ceremony contract.** These rules are the same on every platform:

- Registration requires a discoverable credential, user verification, and PRF
  `enabled: true`. `user.id` is the 32-byte vaultId, and the user name shown by the
  system says this credential unlocks the Lody recovery vault. `excludeCredentials`
  lists known passkeys, because a same-RP, same-`user.id` registration overwrites the
  existing credential on that authenticator.
- A wrap or an unlock requires a real authentication ceremony with
  `userVerification: required`, reporting user verified, and a 32-byte `results.first`.
  WebAuthn reports `enabled` only at registration and never at authentication, so the
  authentication result is judged on `results.first` alone. A result returned at
  registration is not used, because it is optional and enrollment must prove the path
  that later unlocks use.
- The PRF input is one fixed constant, `lody-e2ee/vault-v1/prf-input\0`, because a
  new device does not know vaultId before its ceremony. The existing HKDF, salted by
  vaultId with the `prf-wrap` purpose, separates vaults.
- The credential ID string is its unpadded base64url encoding on every platform, so
  each platform computes the same entryId.
- A missing, disabled or wrong-length result stops with `prf-unavailable`. Nothing
  derives a key from a passkey signature, a login session or a user handle.

**Many passkeys, one V.** Each passkey has its own immutable `prf-wrap` entry holding
the same V; adding one needs V open and changes no other entry. The encrypted index
lists each passkey (entry ID, credential ID, label), and CAS references those entries,
so the service refuses to delete a listed wrap as unreferenced. A vault holds at most
eight passkeys. Enrollment wraps, uploads, reads back, decrypts, commits the index, and
only then reports success. The index addition is a vault-side change made before any
production vault exists. It does not change `formatVersion: 1`, the recovery file or
any ledger record.

**Opening without the file.** The ceremony sends an empty `allowCredentials`. The
returned user handle gives vaultId and the credential ID gives entryId, so no new
service API is needed. The service locator comes from the signed-in client. The user
handle is an unauthenticated hint: only successful decryption, bound to vaultId by the
HKDF salt and AAD, opens the vault.

**macOS.** A native AuthenticationServices module on macOS 15 or newer, in the main
process of the cloud-enabled desktop build. The local-only desktop has no vault and no
RP entitlement. The module enrolls and unlocks. V stays in main, and the renderer never
sees it or the PRF result.

**iPhone.** iOS 18.4 or newer for this feature; the app's own minimum stays lower. A
thin first-party Capacitor plugin calls AuthenticationServices natively; a WebView on
a custom scheme cannot run WebAuthn itself, and a third-party plugin would put an
unreviewed dependency on V's path. The API exists from iOS 18.0, but public reports
describe data-loss bugs in cross-device PRF through iOS 18.3. The iPhone unlocks and
restores in the first phase. V is never retained, and the app must not gain
over-the-air JavaScript updates while this path exists, or it falls under the Web
risk below.

**Web.** Web ships after macOS and iPhone. PRF is judged by a real ceremony, not by a
browser list. When a browser has no PRF, the user uses the recovery file on the same
surface. There is no downgrade. The surface is unlock-only and isolated on the RP host
(owner decision, 2026-11-06): a separate minimal build with no third-party scripts or telemetry, a strict
CSP, and its own deployment credentials. C lives on that origin, and the regular Web
app or any other device then joins through ordinary pairing approved by C. V, R and
the PRF result never reach the regular Web app. V is never stored in a browser.

**Web risk.** Web code is delivered by the server, so tampered code at an origin allowed
by the RP can request a ceremony, take the PRF result and fetch the wrap, which yields V
and every R in the vault. Unlike a compromised browser device, which exposes only that
browser's workspaces, this reaches all covered workspaces and lets the attacker admit
devices until R is revoked. Three limits must be stated plainly:

- *Unlock-only and in-page confirmation are product rules, not security boundaries.*
  Tampered code ignores them and calls WebAuthn directly. Unlock-only is still useful,
  because routine V use never happens on Web.
- *The risk is not confined to Web users.* A passkey enrolled on a Mac syncs and can be
  requested at the RP host from any browser, even if the user never uses Web. Native
  code avoids server-delivered JavaScript, but the credential is not bound to the app.
  An operator controlling the RP host can always try this, even with no Web surface.
- *The real barrier is user approval plus isolation.* The system prompt names the RP
  and the credential and cannot be drawn by page code. A dedicated host excludes
  ordinary compromise of the Web app, its dependencies and its subdomains. It does not
  exclude a hostile operator.

**Other authenticators.** There is no allow-list and no attestation requirement: any
provider works if its real ceremonies meet the contract. Lody promises only iCloud
Keychain on macOS and iPhone. Other managers and hardware keys are not promised. The
first native phase uses only the platform provider, so hardware keys can work only on
Web, where the browser passes PRF through.

**Removal and compromise.** Removing a passkey commits the index, then deletes its
wrap. That stops future use only: a copied wrap plus the credential still opens V. A
suspected passkey or sync-account compromise is treated like a leaked file: replace the
vault and R, and revoke the old R. Sync means the provider account joins the trust base,
so its takeover plus Lody account access can open V.

**Unchanged.** Ledger records and `formatVersion: 1` are unchanged. A passkey grants
R's existing authority and nothing more. Restore notifications, with no forced
replacement, approval or cooldown, apply the same way and name the passkey path.
Recovery and passkey work proceed in parallel with the MVP but are not part of its
acceptance, and stay behind default-off gates that leave creation, joining, pairing
and rotation unchanged.

### Owner decisions

Decided on 2026-11-06: the RP host is `vault.lody.ai`; Web is the isolated unlock-only
surface, after macOS and iPhone, and other devices join it by ordinary pairing; that
surface also accepts the recovery file; the passkey feature requires iOS 18.4; and
recovery and passkey work run now, in parallel.

Awaiting confirmation; this draft is written as if they are accepted:

- **Other authenticators.** Standard WebAuthn with PRF and no allow-list, promising only
  iCloud Keychain.
- **Trust anchor.** The [proposal above](#trust-anchor-proposed-awaiting-owner-confirmation).

## Trust anchor (proposed, awaiting owner confirmation)

**Proposal.** The genesis inside an authenticated recovery package is the trust anchor.
The user saves no fingerprint, prints nothing and asks nobody. This replaces the earlier
"independently confirm" requirement. It needs no ledger change, because the genesis
record already binds the workspace.

**Why this is enough.** A package is a sealed note from the user's own earlier device to
their later one. That device had verified the workspace before it wrote the package, and
only a holder of V can produce one that decrypts. The new device then replays the
complete signed history from that genesis. The history must contain the package's
`head` and `length` checkpoint, and it must show R active; a shorter or forked history
stops. Retained state exported from another device is still not accepted as trust.

**What the old rule guarded against.** The permission ledger says a correct decryption
does not by itself qualify as a trust anchor when a backup location returns another R or
genesis. It predates this analysis and names no attacker. Taken attacker by attacker:

| Attacker | Can do | Other genesis accepted? |
| --- | --- | --- |
| Service or network, no V | Withhold, roll back to an older authentic package, hide newer ledger records | No. It cannot forge a package, and an older package carries the same genesis. |
| Holder of V (leaked file or wrap with its passkey, compromised device retaining V), with vault write access | Write a package naming a lookalike workspace | Yes, but this attacker already opens every real R until it is revoked. |
| Anyone who gets the user to use a file or passkey the attacker made | Present the attacker's own vault, if it can also place that vault under this account | Yes, a lookalike workspace, but the user's real keys stay out of reach. |

**Conclusion.** No attacker without V can make a client accept another genesis, unless
the user is tricked into using the attacker's own file or passkey. In the remaining
cases an independent anchor would help only narrowly: it would stop a lookalike
workspace, which is a forgery the user could type secrets into. It would not protect
real workspaces, and it costs every user a second artifact to keep safe. If that artifact
is lost, recovery fails even though the user holds everything else. The recommendation
is therefore to drop it and accept this residual risk.

**Rules that keep this true.** The client always uses its signed-in service and ignores
the file's `serviceLocator` for connecting; a mismatch stops. A vault that may be
compromised is replaced, not kept. A surviving member may compare workspaces, but
nothing requires it. Existing limits are unchanged: a device that saw no newer state
still cannot prove it holds the latest head. On approval, the matching row in the
[permission ledger](permission-ledger.zh.md) must be reworded in the same change.

## Boundaries and validation

Core defines platform-neutral encrypted storage and local-journal ports and owns
cryptography, index selection, setup and recovery. DTOs live in
`packages/cloud-api`; the private adapter owns authenticated cloud access, not
ledger authority. Lab SQLite implements immutable entries, index CAS and exact
transactional readback. Desktop custody is injected; synthetic Lab protection is
not a production keychain. Cloud login controls retrieval and the file controls
decryption, rather than providing cryptographic two-factor protection.

The [whitepaper](whitepaper.md), [permission ledger](permission-ledger.zh.md) and
[host protection](../../packages/e2ee-core/docs/workflows.md#installedepochkeys-and-installedepochhistory) define the
surrounding boundaries. Approval of this revision is not implementation, deployment
or real-device acceptance; tests and translation do not enable product E2EE.

## Evidence

Intended behavior is the text above. Inspected on 2026-11-05 and not executed:

- [`crypto.ts`](../../packages/e2ee-core/src/internal/recovery/crypto.ts) requires
  `enabled: true` and `results.first` in one object. A real authentication result has no
  `enabled`, so current code would reject it. The [Lab test](../../packages/e2ee-lab/test/recovery-vault.test.ts)
  passes because it uses a synthetic object. This is a gap in code and in the earlier
  wording, not a reduced guarantee.
- [`vault.ts`](../../packages/e2ee-core/src/internal/recovery/vault.ts) already keys
  one `prf-wrap` entry per credential, but needs vaultId and locator from its caller,
  and leaves those entries outside index references.
- No package outside core and the Lab consumes the vault. [#2125](https://github.com/LodyAI/Lody/pull/2125)
  is an unmerged draft with conflicts.

External sources: [WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/) for `enabled`,
optional registration results, the user-verified PRF, `user.id` overwrite and RP scope;
[Apple](https://developer.apple.com/documentation/authenticationservices/asauthorizationpublickeycredentialprfassertioninput-swift.struct)
for macOS 15 and iOS 18 and [associated domains](https://developer.apple.com/documentation/xcode/supporting-associated-domains)
for HTTPS, no redirects and CDN fetching. Browser and provider coverage, including
the iOS 18.0-18.3 reports, comes from secondary sources ([Yubico](https://developers.yubico.com/WebAuthn/Concepts/PRF_Extension/Developers_Guide_to_PRF.html),
[Corbado](https://www.corbado.com/blog/passkeys-prf-webauthn)), which disagree on
some versions. Nothing here was measured on a device, and whether associated domains
work end to end in a Developer ID Electron build remains unproven.
