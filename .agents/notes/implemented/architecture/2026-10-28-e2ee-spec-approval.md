# E2EE Spec approval scope

Status: implemented
Translation: current

[中文](2026-10-28-e2ee-spec-approval.zh.md)

## Abstract

On 2026-10-28, owner Zixuan Chen (zxch3n) explicitly approved the listed E2EE Spec revisions. The permission ledger approval covers only confirmed or implemented portions; unresolved format details require separate review before ledger v1 is frozen. Desktop custody requires real-device acceptance before product activation. Recovery vault remains draft and outside the MVP.

## Decision

The owner approved [atomic removal](../../../../specs/e2ee/atomic-removal.md), [publisher key recoverability](../../../../specs/e2ee/publisher-key-recoverability.md), [snapshot join](../../../../specs/e2ee/snapshot-join.md), and [desktop custody](../../../../specs/e2ee/desktop-custody.md). Before product activation, real-device acceptance must verify packaged Electron with actual system keychains on macOS and Windows.

The [permission ledger](../../../../specs/e2ee/permission-ledger.zh.md) is approved only for confirmed or implemented portions. Section 9 and fields and parameters marked pending confirmation, review, or decision are excluded; ledger v1 needs a separate format review before freezing. The [recovery vault](../../../../specs/e2ee/recovery-vault.md) remains draft and outside the MVP. Approval does not establish product activation or device acceptance.

On 2026-10-28, owner Zixuan Chen (zxch3n), through the E2EE coordinator, additionally approved tag 9 capability declarations, capability 1 and tag 10 removal as implemented. This includes the existing 1–16 strictly ascending nonzero u32 codes, existing length limits, and stopping at an unsupported declaration with `upgrade-required`. This decision follows the [pre-freeze review](https://github.com/LodyAI/Lody/pull/2026); recovery format questions and §9 remain outside this approval.

On 2026-10-28, owner Zixuan Chen (zxch3n), through the E2EE coordinator, approved retaining tag 4 recovery and `possess/v2` bytes without changing genesis; recovery generation and trusted ledger material belong in the encrypted recovery package, while the trust anchor is independently confirmed. The owner also approved recovery package `formatVersion: 1` and the acceptance gates: independently confirm the anchor, import the recovery keys, actually decrypt the current-epoch envelope, and check its commitment. These are format boundaries, not approval of the whole [recovery vault Spec](../../../../specs/e2ee/recovery-vault.md); the vault remains draft and outside the MVP. The [format review](https://github.com/LodyAI/Lody/pull/2026) records the byte layout and evidence.
