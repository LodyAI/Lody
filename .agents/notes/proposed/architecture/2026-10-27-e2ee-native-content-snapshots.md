# E2EE native content snapshots (PR-17 MVP)

Status: proposed
Translation: current

- Date: 2026-10-27
- Chinese: [中文](2026-10-27-e2ee-native-content-snapshots.zh.md)

## Abstract

M2 disabled encrypted content snapshots, so a new replica had to read every update.
PR-17 enables native Streams snapshots through the existing host-owned encryption
and signing binding. Readers require a currently authorized writer, a readable
epoch, valid signature, authenticated continuation and valid AEAD; rejected
snapshots fall back to protected history. This MVP trusts the server and uploader
to associate the native snapshot with honest content at its offset; signatures
provide attribution, not a proof of that association. Production gateway and
whole-workspace performance remain separate acceptance work.

## Decision and boundary

The owner selected native snapshots on 2026-10-27, with no historical-snapshot
retention and a production trim grace assumption of 48 hours. This deliberately
defers the independent record-boundary capability described in the
[foundations draft](../../../../specs/e2ee-foundations.md#settled-content-v0-and-snapshot-continuation)
and does not wait for upstream record-boundary work. The Spec is unchanged.
After a snapshot, old records may disappear after 48 hours: full replay is then
not a guaranteed recovery source. No ledger, content v0 or local-store format
changes, downgrade readers or gitlink changes are introduced.

Desktop main and CLI custody keep all keys and signing. Existing header 4 signs
the complete encrypted snapshot frame including its continuation; room AAD binds
workspace/resource/model. Sealing checks current epoch and writer permission
before and after signing. Reading verifies historical signature before key lookup,
then AEAD and the exact native continuation. Snapshot authors must still be current
non-Guest personal/machine writers both before key lookup and after decryption.
Historical update reads continue to accept admitted authors after revocation.
The final snapshot check reuses the already verified owned bytes and genuine
ledger continuation; it checks current permission without repeating signature verification.

## Scheduling and recovery

Only local writers trigger the SDK snapshot scheduler. After 30 seconds without
another local write, it checks the remote snapshot and requires 1 MiB of additional
stream bytes. The SDK suppresses a competing writer observed during debounce,
requires complete persisted progress with no local pending writes, and owns one
upload flight across room generations. Multiple devices can still race; this is
best-effort coordination, not distributed leader election. The core seal remains
the authority gate even when the scheduling hint says yes.

The SDK captures native state and offset together; export is serialized, while
compression, signing and upload run outside the edit queue. Upload failure logs
and remains eligible after a later local write; it does not reject editing or
incremental sending. Close uses the existing SDK owner. This patch adds no global
fence, persistent failure collection, new background timer or cleanup owner.

The pinned streams-crdt 0.19.2 patch marks only protected snapshot decode failures,
before CRDT import or cursor save. It discards the bootstrap suffix and reads from
origin through the same protected update decoder and durability barriers. A 410
ends that attempt instead of re-bootstrapping in a loop. Validated error fields
carry `protocol_error` / `payload_protection` / `bootstrap` / `gone`; the shared
formatter asks a device holding data to publish a fresh snapshot, then retry.
No raw exception text is displayed. A repaired native snapshot can be retried
without deleting local drafts or cursors. Ordinary workspaces retain their prior
snapshot, upload, error and transport paths.

## Evidence and limits

Deterministic suites use real Loro, IndexedDB, cryptography and host custody
fixtures with synthetic keys. They cover snapshot plus suffix, invalid signature,
AEAD, continuation and unavailable snapshot key; full-history fallback; trimmed
history refusal with unchanged local state; and retry after replacement snapshot.
Core covers revocation before open and during key lookup, retaining old updates.
Affected checks and reversible ablations are reported in the PR.

The existing finite Effect core remains native. Repo/SDK Promise integration stays
at its existing application facade; migrating those unfinished dependencies would
expand this task without improving the snapshot boundary.

The [isolated Electron trial](../../../../apps/electron/scripts/e2ee-ipc-benchmark.md)
records performance and its limits. Docker preflight found no running daemon
(`~/.orbstack/run/docker.sock` absent), so private local-stack/real gateway,
production 48-hour trim configuration, OS custody, installers, other platforms and
whole-workspace startup were not verified. No private backend change is included.
