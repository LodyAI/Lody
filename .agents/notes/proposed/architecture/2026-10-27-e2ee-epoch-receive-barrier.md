# PR20-C: receive epochs without stopping sends

Status: proposed
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1954

[中文](2026-10-27-e2ee-epoch-receive-barrier.zh.md)

## Abstract

The owner's availability-first MVP decision supersedes the former mandatory send barrier. rotationRequired is only a manual administrator hint; eligible devices keep sealing with a retained published epoch while current-key reception retries. Existing rooms use one stable provider that chooses an installed epoch at the start of each operation. Readback commits the new selection synchronously; a failed or timed-out attempt leaves old sends and local data usable. No automatic signing or saved-format rollback is introduced.

## Authority and selection

The native workspace owns its verified ledger, installed keys and receive journal. Staging locators come from genuine publication records; KeyReceiver repeats signature, publication, recipient, HPKE and commitment checks. Historical mailbox/history recovery remains. Every seal checks current membership and device authority before encryption and after signing, even when using an older published epoch. Revoked, removed, Guest and Recovery writers stay denied. A genuine later ledger during signing no longer rejects an otherwise valid earlier-epoch frame. Namespace, wire domains, commitments and original bytes are unchanged.

A stable room provider captures its epoch once per operation. Confirmed current-key receipt changes the selection without awaiting I/O, replacing transports, reopening a Repo or deleting queues. Existing operations may finish valid old-epoch frames. Native status identifies a verified retained writeEpoch on reopen, so absent current keys do not discard an otherwise usable local replica. Credential loss or having no usable key cannot be bypassed.

The old SDK strong-close patches, drain/restart API and their obsolete tests are removed from this PR. There is no new SDK version or outer-workspace patch adoption requirement. Active token owners invalidate after selection advances; desktop future token owners also separate cache identity by selected epoch. rotationRequired alone does not invalidate tokens.

## Failure containment

- Trigger: startup, verified epoch advancement, reconnect or explicit retry. Manual rotation signing and the administrator settings badge/button belong to PR20-D.
- Owner: one selection/reception attempt in the existing renderer/CLI workspace and native scopes; no global network lock or new retry daemon.
- Cancellation: a ten-second waiter deadline does not release raw native work. At most one unfinished installation remains owned; late/timed-out or superseded receipts cannot select a key. Close retires selection callbacks and joins native/crypto work.
- Handoff: installation plus verified readback precedes one synchronous selection update; no destructive step needs rollback. Existing provider and transport owners remain usable.
- Failure: reception errors, missing keys and timeouts are visible and retryable, while the old verified epoch continues sending. Independent workspaces remain independent. Local-storage verification failures retain their existing security checks. A seal only requests coalesced storage repair and returns a retryable failure; it never awaits refresh from the SDK save queue. After verified ingest, the next SDK save uses the retained epoch even while key reception is still pending.

This accepts the owner's MVP tradeoff: a revoked device retaining an epoch key can decrypt ciphertext it obtains. Server credential/token authorization and absolute expiry bound access. No plaintext fallback or restoration of revoked write permission is permitted.

## Evidence and limits

Deterministic regressions cover ongoing same-provider sends, failures, timeout/late receipt, missing/superseded keys, another workspace sending, retained-key cold startup, native SQLite/crypto reopen and committed staging reception. Each changed behavior has a fix-withdrawn RED run before GREEN. These are local boundary checks, not installed-product acceptance. Real gateway revocation/long connections, OS keychains, two-device installed apps, cross-platform packaging and a full fifteen-minute access bound remain unverified. Real SDK save-queue regressions inject SQLite busy, hold history and key reception, then prove prompt failed-save settlement and successful retained-data upload/decryption on the next attempt. Legacy token invalidation after close begins is idempotent; failed close still retains its raw owner and Cause for cleanup retry. Full repository tests belong to CI.

The core advisory-permission change is independently reviewed in [#1956](https://github.com/LodyAI/Lody/pull/1956). Document retained-epoch compatibility lives here so this PR has no stacked branch dependency. This supersedes the blocking interpretation in [M2](2026-10-22-e2ee-m2-product-integration.md) under the explicit owner instruction. Native Effect consumer migration remains separate in the [roadmap](2026-09-27-effect-lifecycle-migration-roadmap.md#unit-ledger).
