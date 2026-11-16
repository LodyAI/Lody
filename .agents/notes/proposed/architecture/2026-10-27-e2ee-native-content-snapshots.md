# E2EE native content snapshots (PR-17 MVP)

Status: proposed
Translation: current

- Date: 2026-10-27
- PR: [#1959](https://github.com/LodyAI/Lody/pull/1959), [#2728](https://github.com/LodyAI/Lody/pull/2728)
- Backend companion: [#3873](https://github.com/loro-dev/lody/pull/3873)
- Chinese: [中文](2026-10-27-e2ee-native-content-snapshots.zh.md)

## Abstract

M2 disabled encrypted content snapshots, so a new replica had to read every update.
PR-17 enables native Streams snapshots through the existing host-owned encryption
and signing binding. Readers require a historically admitted signer, a readable
epoch, valid signature, authenticated continuation and valid AEAD; rejected
snapshots fall back to protected history from origin when available. This MVP trusts the server and uploader
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
workspace/resource/model. After composing merged #1954, a seal keeps its single
selected `writeEpoch` across header construction, encryption and signing, including
an already admitted seal that finishes during a transition. Pending/manual key
rotation may use a retained published epoch no later than the current one; current
writer permission is still checked before and after signing. Reading verifies historical signature before key lookup,
then AEAD and the exact native continuation. The owner's later decision on the same
date supersedes the initial current-writer read gate: historically admitted devices
remain acceptable snapshot signers after revocation; never-admitted keys are rejected.
The final snapshot check reuses owned verified bytes and genuine ledger continuation.
Upload still requires a current writer and its selected published epoch. There are no production encrypted
workspaces to migrate and no old snapshot-format reader is retained.

## Scheduling and recovery

Only local writers trigger the SDK snapshot scheduler. After 30 seconds without
another local write, it checks the remote snapshot and requires 1 MiB of additional
stream bytes (`minBytesSinceRemoteSnapshot`). Ordinarily, the SDK suppresses upload when a competing writer is observed during debounce (`observedForeignWriter`); however, once stream growth since the last remote snapshot reaches the hard ceiling `maxBytesSinceRemoteSnapshot` (4 MiB), foreign-writer observation no longer suppresses upload so alternating human/agent or multi-device writes cannot defer snapshots indefinitely. Upload still requires complete persisted progress with no local pending writes, and owns one
upload flight across room generations. Multiple devices can still race; this is
best-effort coordination, not distributed leader election. The core seal remains
the authority gate even when the scheduling hint says yes.

The SDK captures native state and offset together; export is serialized, while
compression, signing and upload run outside the edit queue. Upload failure logs
and remains eligible after a later local write; it does not reject editing or
incremental sending.

`@loro-dev/streams-crdt@0.20.0` (upstream [loro-streams#457](https://github.com/loro-dev/loro-streams/pull/457)) natively marks protected snapshot decode failures and
rejects an empty/missing snapshot at a non-origin position before CRDT import or
cursor save. An empty response cannot certify a non-origin cursor. It discards the bootstrap suffix and reads from
origin through the same protected update decoder and durability barriers (`catchupOrGone(this.createInitialCursor(), ...)`). If history is already trimmed (410 Gone), the rejected snapshot fails with the validated recovery cause while preserving local state and cursors. The earlier 5-second `<native-stream>:snapshot-repair` `HEAD` polling and hint channel were removed in [#2728](https://github.com/LodyAI/Lody/pull/2728) to eliminate continuous 404 polling overhead on live rooms.

With the upgrade to `@loro-dev/streams-crdt@0.20.0`, the local `patches/@loro-dev__streams-crdt@0.19.2.patch` has been removed; protected snapshot history fallback, `maxBytesSinceRemoteSnapshot` forced-checkpoint thresholds, and Flock local export coalescing are all provided directly by the released SDK.

## Evidence and limits

Deterministic suites use real Loro, IndexedDB, cryptography and host custody
fixtures with synthetic keys. They cover snapshot plus suffix, invalid signature,
AEAD, continuation, unavailable snapshot key and missing non-origin snapshot; full-history fallback; trimmed
history failure with unchanged local state and cursor; and forced snapshot upload when alternating writers reach the 4 MiB `maxBytesSinceRemoteSnapshot` threshold. Concurrent native
plaintext joins retain one owner and close all live work. Core accepts revoked signers before open/during key lookup
and rejects never-admitted signers plus workspace/document replay.
Affected checks and reversible ablations are reported in the PR.

Lab coverage distinguishes successful verified-history fallback from a rejected
snapshot whose history is already trimmed. The latter retains the SDK's validated
410 recovery cause rather than misclassifying an earlier provider error as local
corruption. SQL refusal still preserves both native state and cursor. The Loro/Flock
three-role plans check authentic bootstrap and reopen
its durable result; they do not fabricate host history. The old CLI actor failure
is fixed by main's approved Claude submodule pin, with its original assertion kept.

The existing finite Effect core remains native. Repo/SDK Promise integration stays
at its existing application facade; migrating those unfinished dependencies would
expand this task without improving the snapshot boundary.

The [isolated Electron trial](../../../../apps/electron/scripts/e2ee-ipc-benchmark.md)
records performance and its limits. Docker preflight found no running daemon
(`~/.orbstack/run/docker.sock` absent), so private local-stack/real gateway,
production 48-hour trim configuration, OS custody, installers, other platforms and
whole-workspace startup were not verified. No new whole-product timing claim is made.
