# E2EE Spec approval scope

Status: implemented
Translation: current

[中文](2026-10-28-e2ee-spec-approval.zh.md)

## Abstract

Owner Zixuan Chen (zxch3n) approved the listed E2EE Spec revisions on 2026-10-28 and the exact client custody Spec revision below on 2026-10-29. The permission ledger approval covers only confirmed or implemented portions; unresolved format details require separate review before ledger v1 is frozen. Desktop custody requires real-device acceptance before product activation. Client custody approval establishes intent, not platform acceptance. On 2026-10-31 the owner approved the recovery vault Spec revision recorded below.

## Decision

The owner approved [atomic removal](../../../../specs/e2ee/atomic-removal.md), [publisher key recoverability](../../../../specs/e2ee/publisher-key-recoverability.md), [snapshot join](../../../../specs/e2ee/snapshot-join.md), and [desktop custody](../../../../specs/e2ee/desktop-custody.md). Before product activation, real-device acceptance must verify packaged Electron with actual system keychains on macOS and Windows.

The [permission ledger](../../../../specs/e2ee/permission-ledger.zh.md) is approved only for confirmed or implemented portions. Section 9 and fields and parameters marked pending confirmation, review, or decision are excluded; ledger v1 needs a separate format review before freezing. The [recovery vault](../../../../specs/e2ee/recovery-vault.md) remains draft and outside the MVP. Approval does not establish product activation or device acceptance.

On 2026-10-28, owner Zixuan Chen (zxch3n), through the E2EE coordinator, additionally approved tag 9 capability declarations, capability 1 and tag 10 removal as implemented. This includes the existing 1–16 strictly ascending nonzero u32 codes, existing length limits, and stopping at an unsupported declaration with `upgrade-required`. This decision follows the [pre-freeze review](https://github.com/LodyAI/Lody/pull/2026); recovery format questions and §9 remain outside this approval.

On 2026-10-28, owner Zixuan Chen (zxch3n), through the E2EE coordinator, approved retaining tag 4 recovery and `possess/v2` bytes without changing genesis; recovery generation and trusted ledger material belong in the encrypted recovery package, while the trust anchor is independently confirmed. The owner also approved recovery package `formatVersion: 1` and the acceptance gates: independently confirm the anchor, import the recovery keys, actually decrypt the current-epoch envelope, and check its commitment. These are format boundaries, not approval of the whole [recovery vault Spec](../../../../specs/e2ee/recovery-vault.md); the vault remains draft and outside the MVP. The [format review](https://github.com/LodyAI/Lody/pull/2026) records the byte layout and evidence.

## Web and mobile custody authorization

On 2026-10-29, owner Zixuan Chen (zxch3n), as relayed by the E2EE coordinator in the implementation assignment, approved trusting server-delivered Web code with honest UI/documentation disclosure; a persisted non-extractable AES-GCM KEK wrapping pure-JS Ed25519/X25519 keys; device-bound mobile protection available after first unlock; and desktop reapproval after storage loss, reinstall or uncertain installation. Persistent protection is required: there is no plaintext fallback or automatic replacement identity. Ledger v1 and its bytes remain unchanged.

Native curve-only custody was not chosen because browser/native curve availability must not raise the iOS/iPadOS 16.4 floor. Non-extractability is not isolation from application code, a malicious server, XSS or browser compromise. This records the authorized public decision scope only; it includes no private task or deployment record. The exact client custody revision approval is recorded below. Implementation, platform acceptance, deployment and recovery-vault approval are separate; desktop real-keychain acceptance remains required.

## Client custody revision approval

On 2026-10-29, owner Zixuan Chen (zxch3n) explicitly approved the client custody Spec at revision `e1e3b5a10f65d94655d097cd262f008a35c2688e`, as relayed by the E2EE coordinator for [PR #2038](https://github.com/LodyAI/Lody/pull/2038). The approved [English text](https://github.com/LodyAI/Lody/blob/e1e3b5a10f65d94655d097cd262f008a35c2688e/specs/e2ee/client-custody.md) has Git blob `d2a817abf5ccf10d72496e6fa3b453ca74e37de2`; the approved [Chinese text](https://github.com/LodyAI/Lody/blob/e1e3b5a10f65d94655d097cd262f008a35c2688e/specs/e2ee/client-custody.zh.md) has Git blob `af4b5d9842b96101f1fa38d2cf0909780e552517`. The owner confirmed these five scope points:

1. Web application code can unwrap and use private keys. Trust in server-delivered code is accepted and disclosed; a non-extractable KEK does not isolate keys from that code.
2. Mobile protection is available after first unlock, without biometric approval per use. Android makes no TEE or StrongBox guarantee.
3. In-place recovery is allowed only when retained evidence confirms the same interrupted installation. Otherwise require new desktop approval and atomic identity replacement, retaining the old receipt and unresolved originals.
4. Ordinary logout and cache cleanup retain identity and unresolved originals.
5. Ledger v1 and its bytes stay unchanged. Spec approval is not implementation, deployment or real-device acceptance, and does not approve the recovery vault.

The approval metadata and links added after this revision do not change its technical text. The [current Spec](../../../../specs/e2ee/client-custody.md) records this approval; actual native keychain/keystore, first-unlock, minimum-OS and device acceptance remain separate evidence.

On 2026-10-29, owner Zixuan Chen, through the E2EE coordinator, approved shortening E2EE content-token validity to 480 seconds as the launch mitigation: 480 seconds plus 60 seconds of JWT leeway plus one 300-second SSE lifetime gives a nominal 840-second budget. The remaining 60 seconds is headroom, not a bound on buffering, upstream waits/retries, clock error or storage commit. Strict gateway expiry is deferred and does not block launch. This documentation records the decision, not private-backend deployment or real-gateway acceptance. Independent removal and later manual rotation retain the approved tag 10 semantics.

## Device revocation retention exception

On 2026-10-31, owner Zixuan Chen (zxch3n), through the E2EE coordinator, approved extending the ordinary key-retention exception to a credential-confirmed revocation of this device, at revision `145c7a5e61e71b04f8b89e7801b01bb0fcccd9fc`. The approved texts are [desktop custody](https://github.com/LodyAI/Lody/blob/145c7a5e61e71b04f8b89e7801b01bb0fcccd9fc/specs/e2ee/desktop-custody.md) (blob `cbfc986784d7fe89a162bf0fd29f16b76124574a`, Chinese `7cecb36a44e25ba814110fc68240ff3c80ec4c61`), [client custody](https://github.com/LodyAI/Lody/blob/145c7a5e61e71b04f8b89e7801b01bb0fcccd9fc/specs/e2ee/client-custody.md) (blob `d19dd471113d3f61ef5451a414761e21b1552898`, Chinese `1ea279bfd0abd707a78c053c46cc5f416611364c`) and the [whitepaper](https://github.com/LodyAI/Lody/blob/145c7a5e61e71b04f8b89e7801b01bb0fcccd9fc/specs/e2ee/whitepaper.md) paragraphs on self-device revocation and deletion (blob `dd0aab07ada8c2220cd0fae4beb80d2b894b49b8`, Chinese `fcb311aa398f0f9fb6a883d311039ac2e8266ddc`). Scope: only the exact typed revocation result qualifies; cleanup erases only this device's workspace identity, content and keys, keeps the membership and the member's other devices, and allows pairing again with a new identity. Ordinary failures still never authorize deletion. This is honest-client cleanup, not secure erasure of earlier copies. The rationale is in [desktop device revocation](2026-10-30-e2ee-desktop-device-revocation.md).

## Recovery vault desktop integration

On 2026-10-31, owner Zixuan Chen (zxch3n), as relayed by the E2EE coordinator, explicitly approved the recovery vault Spec at revision `cd752bbfff7a8cb11f11570ed6b76853075d9565` ([PR #2123](https://github.com/LodyAI/Lody/pull/2123)). The approved [English text](https://github.com/LodyAI/Lody/blob/cd752bbfff7a8cb11f11570ed6b76853075d9565/specs/e2ee/recovery-vault.md) has Git blob `b380514af1a0b43f9d26f93cbe0419717596a2f6`; the approved [Chinese text](https://github.com/LodyAI/Lody/blob/cd752bbfff7a8cb11f11570ed6b76853075d9565/specs/e2ee/recovery-vault.zh.md) has Git blob `23a1cd28ea6451858844859c31405bad66b95bb0`. The approved revision is `cd752bbf`; later changes to the Spec are editorial only (approval metadata and wording that the Spec is approved). The approval covers the six desktop integration decisions:

1. One vault and one recovery file per account.
2. V may be retained on a desktop only behind per-use user presence (macOS Keychain user-presence access control; Windows Hello or a credential prompt). This is an exception for V alone; without platform support the user supplies the file and V is never stored silently.
3. R's access credential is HKDF-SHA256 over R's 32-byte Ed25519 seed, with salt = genesis hash and info = `lody-e2ee/recovery-credential/v1\0` followed by R's signing public key. The SHA-256 of that credential is registered through the existing `credentialHash`. The package format is unchanged.
4. Passkey PRF uses a native macOS 15+ AuthenticationServices module with a Lody `webcredentials:` associated domain, AASA and an embedded provisioning profile, after native dependency review. A real ceremony must report PRF enabled with a 32-byte `results.first`; there is no fallback.
5. The exact 48-byte RFC 8410 PKCS#8 package key encoding.
6. A successful restore notifies the account's active devices and email; there is no forced R replacement, owner approval or cooldown.

Approval establishes intent only, not implementation, deployment or real-device acceptance. The private backend gap remains: no `e2eeRecoveryVault` storage, Recovery credential registration, R-authenticated mailbox access or restore notification. The recovery vault remains outside the MVP.
