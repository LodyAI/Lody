# E2EE native content snapshots (PR-17 MVP)

Status: proposed
Translation: current

- Date: 2026-10-27
- PR: [#1959](https://github.com/LodyAI/Lody/pull/1959)
- Backend companion: [#3873](https://github.com/loro-dev/lody/pull/3873)
- Chinese: [中文](2026-10-27-e2ee-native-content-snapshots.zh.md)

## Abstract

M2 disabled encrypted content snapshots, so a new replica had to read every update.
PR-17 enables native Streams snapshots through the existing host-owned encryption
and signing binding. Readers require a historically admitted signer, a readable
epoch, valid signature, authenticated continuation and valid AEAD; rejected
snapshots request automatic republication and fall back to protected history when available. This MVP trusts the server and uploader
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
then AEAD and the exact native continuation. The owner's later decision on the same
date supersedes the initial current-writer read gate: historically admitted devices
remain acceptable snapshot signers after revocation; never-admitted keys are rejected.
The final snapshot check reuses owned verified bytes and genuine ledger continuation.
Upload still requires a current writer and epoch. There are no production encrypted
workspaces to migrate and no old snapshot-format reader is retained.

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
incremental sending. Repair uses the same upload owner and complete-state checks,
but bypasses ordinary byte/debounce and competing-writer suppression and permits
replacement at the same offset. Permission, complete cursor/state, no pending local
writes and current room ownership remain mandatory.

The pinned streams-crdt 0.19.2 patch marks protected snapshot decode failures and
rejects an empty/missing snapshot at a non-origin position before CRDT import or
cursor save. An empty response cannot certify a non-origin cursor. It discards the bootstrap suffix and reads from
origin through the same protected update decoder and durability barriers, without
waiting for repair. A rejected snapshot also requests a fixed one-byte hint in
`<native-stream>:snapshot-repair` (TTL 120 seconds, request coalescing 30 seconds).
The existing credential-authenticated content-token action relays that hint for
read-only Guests; its exact-stream write token stays on the backend. A protected-only
SDK recovery notification reaches the host even when an absent/malformed envelope
never calls `provider.open`; notification failure cannot change synchronization. Normal Guest
content tokens remain read-only. Backend writes no business CRDT data.

Each live protected room polls hints every five seconds; a complete current writer
republishes with at most one successful repair per 30 seconds per device/room.
Failed repair remains eligible at the next poll and never fails editing or sending.
If history is trimmed, the original live subscription waits and retries bootstrap
on that interval until a valid replacement appears. Closing cancels its wait and
owned requests/timer. The desktop displays the request/retry hint; CLI diagnostics
use fixed text and validated fields, never raw provider exceptions. Local state and
cursors survive. No distributed election or new backend infrastructure is added.
Ordinary workspaces do not create this channel, timer or request traffic.

The root pnpm `patchedDependencies` applies
`patches/@loro-dev__streams-crdt@0.19.2.patch`; the lockfile pins its hash. Frozen
installation rejects a missing/inconsistent patch. On SDK upgrade, port the patch
or prove equivalent native behavior by running the owning transport suite: bad
signature/tag/offset/key replay cases, automatic repair without another edit, and
close while waiting. Removing the patch makes those behavioral tests fail. The
private outer workspace must mirror the patch declaration using `lody-oss/patches/`
and regenerate its own lockfile when adopting the merged public head. This PR does
not change its gitlink. The separate private backend PR supplies snapshot-write
permission and Guest relay; both are required for cloud acceptance.

## Evidence and limits

Deterministic suites use real Loro, IndexedDB, cryptography and host custody
fixtures with synthetic keys. They cover snapshot plus suffix, invalid signature,
AEAD, continuation, unavailable snapshot key and missing non-origin snapshot; full-history fallback; trimmed
history waiting with unchanged local state; automatic replacement at the same offset;
and close cancellation. A complete writer responds even after ordinary debounce
observed a competing writer, under the production 1 MiB gate. Concurrent native
plaintext joins retain one owner and close all live work. Core accepts revoked signers before open/during key lookup
and rejects never-admitted signers plus workspace/document replay.
Affected checks and reversible ablations are reported in the PR.

The existing finite Effect core remains native. Repo/SDK Promise integration stays
at its existing application facade; migrating those unfinished dependencies would
expand this task without improving the snapshot boundary.

The [isolated Electron trial](../../../../apps/electron/scripts/e2ee-ipc-benchmark.md)
records performance and its limits. Docker preflight found no running daemon
(`~/.orbstack/run/docker.sock` absent), so private local-stack/real gateway,
production 48-hour trim configuration, OS custody, installers, other platforms and
whole-workspace startup were not verified. The isolated performance trial predates
the repair change; no new whole-product timing claim is made.
