# E2EE Spec approval scope

Status: implemented
Translation: current

[中文](2026-10-28-e2ee-spec-approval.zh.md)

## Abstract

Owner Zixuan Chen (zxch3n) approved the listed E2EE Spec revisions on 2026-10-28 and the exact client custody Spec revision below on 2026-10-29. The permission ledger approval covers only confirmed or implemented portions; unresolved format details require separate review before ledger v1 is frozen. Desktop custody requires real-device acceptance before product activation. Client custody approval establishes intent, not platform acceptance; recovery vault remains draft.

## Decision

The owner approved [atomic removal](../../../../specs/e2ee/atomic-removal.md), [publisher key recoverability](../../../../specs/e2ee/publisher-key-recoverability.md), [snapshot join](../../../../specs/e2ee/snapshot-join.md), and [desktop custody](../../../../specs/e2ee/desktop-custody.md). Before product activation, real-device acceptance must verify packaged Electron with actual system keychains on macOS and Windows.

The [permission ledger](../../../../specs/e2ee/permission-ledger.zh.md) is approved only for confirmed or implemented portions. Section 9 and fields and parameters marked pending confirmation, review, or decision are excluded; ledger v1 needs a separate format review before freezing. The [recovery vault](../../../../specs/e2ee/recovery-vault.md) remains draft and outside the MVP. Approval does not establish product activation or device acceptance.

On 2026-10-28, owner Zixuan Chen (zxch3n), through the E2EE coordinator, additionally approved tag 9 capability declarations, capability 1 and tag 10 removal as implemented. This includes the existing 1–16 strictly ascending nonzero u32 codes, existing length limits, and stopping at an unsupported declaration with `upgrade-required`. This decision follows the [pre-freeze review](https://github.com/LodyAI/Lody/pull/2026); recovery format questions and §9 remain outside this approval.

On 2026-10-28, owner Zixuan Chen (zxch3n), through the E2EE coordinator, approved retaining tag 4 recovery and `possess/v2` bytes without changing genesis; recovery generation and trusted ledger material belong in the encrypted recovery package, while the trust anchor is independently confirmed. The owner also approved recovery package `formatVersion: 1` and the acceptance gates: independently confirm the anchor, import the recovery keys, actually decrypt the current-epoch envelope, and check its commitment. These are format boundaries, not approval of the whole [recovery vault Spec](../../../../specs/e2ee/recovery-vault.md); the vault remains draft and outside the MVP. The [format review](https://github.com/LodyAI/Lody/pull/2026) records the byte layout and evidence. On 2026-10-31, the owner, through the E2EE coordinator, also accepted that both recovery private keys are exactly the 48-byte RFC 8410 PKCS#8 encodings for Ed25519 and X25519 ([#2124](https://github.com/LodyAI/Lody/pull/2124)); other encodings are rejected. This is a package-format boundary only; the vault Spec remains draft.

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
