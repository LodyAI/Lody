# Recover journaled epoch publications without restaging

Status: proposed
Translation: current

[中文](2026-10-28-e2ee-journaled-publication-recovery.zh.md)

## Abstract

After a complete epoch group was staged and exactly read back, its CAS can remain unknown at the original parent. Repeating staging during `EpochPublisher.resume` let a later staging outage block device revocation and member removal. The submission journal already preserves the exact publication that passed the initial staging boundary.

## Decision

Only a candidate without a matching journal original repeats staging/readback. A matching original resumes ledger reconciliation and CAS directly. CandidateProtector payload/commitment checks, original-parent authorization, genuine checkpoint/install proof and acknowledgement are unchanged. A missing unpublished candidate still cannot authorize a CAS at the unchanged parent. No record is re-signed, no journal is discarded, and no wire/storage format changes.

The existing workspace Scope, management admission and ordinary submission journal retain ownership across cancellation, native work and close. Failed ledger recovery keeps the same original for retry; successful publication installs the committed key and acknowledges before the next ordinary command signs. Management keeps its existing independent committed-key repair path. Native member removal and revocation share `host.manage`; only the internal removal command/type is brought forward from the product work so both real entry paths are covered. Member UI/IPC and local-data deletion remain separate. This unit already uses native Effect v4; no new migration, owner or retry loop is introduced.

## Evidence and limits

Real crypto/SQLite regressions are RED before the publisher fix for both native revocation and member removal after reopen with CAS unknown and staging unavailable. Core recovery uses a dead signer and failing staging/readback ports, verifies the original committed bytes, installs the key and acknowledges. The native cases also cover a missing old-epoch key, an unsubmitted candidate, a still-unavailable CAS, unchanged originals and completed membership/device projection changes. Existing missing/damaged candidate, conflict and installation-retry cases remain covered. A reception-order withdrawal remained GREEN; it is not required for this fix, so that extra restructuring is excluded.

Final affected checks and CI are recorded in the PR. These tests do not establish real keychain, multi-device installation or live staging/gateway acceptance. No merge, deployment or private gitlink adoption.
