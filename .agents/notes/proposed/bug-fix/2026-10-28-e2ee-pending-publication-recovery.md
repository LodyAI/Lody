# Pending epoch publication recovery without staging availability

Status: proposed
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1987

[中文](2026-10-28-e2ee-pending-publication-recovery.zh.md)

## Abstract

An unknown epoch CAS was forced through staging again when the verified ledger still ended at its parent. A subsequent staging outage then blocked otherwise healthy device revocation. EpochPublisher now resumes a matching retained submission directly, preserving exact signed bytes, installation checks and acknowledgement. First submissions retain complete staging/readback; no format, signer or ownership boundary changes.

## Recovery boundary

The publisher persists its candidate, stages the complete group and verifies exact readback before creating the submission journal entry. Recovery first checks that the retained submission record equals the validated candidate record. A match resumes LedgerSubmission without repeating staging I/O; the journal is an ordering receipt, never ledger authority. Genuine ledger binding and installed-key verification still precede success/acknowledgement. Unknown CAS outcomes keep their original bytes and cannot authorize replacement signatures.

A candidate with no matching submission still needs staging/readback before its first CAS. Independent revocation can bypass that local-only candidate under the existing [manual management decision](../architecture/2026-10-27-e2ee-manual-key-management.md). The core publisher remains the recovery owner under the host's existing scoped admission/drain; no background owner or retry loop is added. Member-removal consumers can reuse the same recovery path without a second signer or journal.

## Evidence and limits

The existing native SQLite/crypto revocation regression now loses the CAS result, reopens the host, and makes both staging writes and reads fail. It verifies that unknown CAS still retains its original, then the healthy CAS path installs/acknowledges that publication and commits revocation while staging remains unavailable. The pre-fix test fails on renewed staging; with the fix it passes. The candidate-only failure case retains its existing first-submission checks. Tests use synthetic custody and remote ports, not a deployed service or real OS keychain.
