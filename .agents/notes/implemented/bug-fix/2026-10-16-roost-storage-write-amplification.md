# Bound Roost streaming writes with atomic native deltas

Status: implemented
Translation: current

[中文](2026-10-16-roost-storage-write-amplification.zh.md)

## Abstract

The previous streaming path replaced complete message content and retained full
commands and baseline snapshots in SDK batch-receipt Turns. A synthetic 128-step
comparison produced a 56.2 MB database for a final 42,939-byte message, versus
0.37 MB with native text splices. Existing mutable messages now use the installed
Native API's atomic field/text edits and compact local operation receipts,
preserving idempotent recovery without storing another full snapshot per chunk.
Actual SQLite tests bound update bytes and projection rows across 128 chunks,
lost replies, Unicode edits, sealing/state corrections and reopen. Existing large
databases are not compacted, and these results do not diagnose production latency.

## Evidence and version correction

The old `planTurnWrite` emitted `setContent(encodeRoostContent(after))`.
The installed TypeScript SDK's `writeIndexed` replaced the full content field.
Its `commitBatch` created a `batch_receipt` Turn with `commands` and `bases`;
`encodeProjected` included each base's complete content. Finalization sealed
that receipt while retaining the snapshots.

Correction: the inspected TypeScript package is `@loro-dev/roost@0.1.3`, not
0.1.2 as initially labelled. Native is `@loro-dev/roost-node@0.1.2`, source
revision `9845bea5170f7a3e4935ce4ff12d5245febc80f9`. Installed versions and
the lockfile are unchanged. Another local checkout did not contain that exact
native release revision and is not version-matched release evidence.

The Native Worker still executes one request at a time across Lody's shared
database. Upper read/write pools cannot compensate for repeatedly submitting
large snapshots to that FIFO.

## Synthetic SQLite comparison

Six local runs used the installed Native client and `NodeLodyHistory`. Each
message had an unchanged 8 KiB tool result, 96 small fields, and 256 text bytes
appended per step. Final content was equal within each step-count group.
Owners closed before read-only aggregation; there were no network calls,
real messages, sleeps or timing assertions.

| Steps | Write path | Final JSON bytes | Database file bytes | Projection rows |
| --- | --- | --- | --- | --- |
| 64 | Native splice | 26,555 | 237,568 | 224 |
| 64 | Native replacement | 26,555 | 2,781,184 | 224 |
| 64 | SDK batch replacement | 26,555 | 20,144,128 | 31,773 |
| 128 | Native splice | 42,939 | 372,736 | 240 |
| 128 | Native replacement | 42,939 | 7,557,120 | 240 |
| 128 | SDK batch replacement | 42,939 | 56,217,600 | 65,373 |

The 128-step batch case contained one visible message and 128 hidden receipts.
Projection key/value bytes totalled 10,211,755, updates 10,408,926 and outbox
10,396,622. Database file size includes SQLite page/index overhead and is not
cumulative I/O. Native replacement alone kept 240 projection rows: JSON's
node-per-value representation cannot alone explain 65,373 rows.

Probe scripts and aggregate logs stayed outside the repository; temporary
synthetic databases were removed. The user's reported 19.5 GB database is a real
reported incident, not disproved by the lightly used local 2.8 MB database.
Its production statistics and timing were not independently measured here.

## Implemented write boundary

The installed public Native API already supports an atomic `writeBatch` with
guarded edits and index puts. Therefore an SDK upgrade or a copied implementation
of SDK batch sagas was unnecessary.

After the existing validation and batch preparation, eligible existing unsealed
primary/state records receive exact-sequence field operations. Text appends use
`appendText`; other string edits use scalar-offset `spliceText`. Objects,
lists, additions and removals preserve unaffected content. Finishing a mutable
primary seals it in that same transaction; its seal guard advances by the number
of content operations, not by one batch. All affected edits and per-item
receipts commit together under the generation's native cursor guard.

The local `lody_agent_operation_receipts_v1` index stores only a version and
digest under the canonical publication identity. It contains no command, body or
baseline snapshot. Receipt lookup checks retained generation ancestors and the
previous SDK receipts, preserving retry/conflict behavior across reopen and branch
handoff. This is an owner-local operation journal, not a remotely replicated
acceptance proof.

New records, stitched primaries, sealed targets without a mutable state, oversized
batches and non-publication contracts retain the SDK path. Immutable human input,
permissions, generation/branch activation and their signed recovery evidence are
not converted to this local journal. Native errors propagate; a failed or uncertain
atomic write is not retried through a second SDK path.

## Correction: ACP encoding and command checkpoints

The first local distribution exposed a regression in this native delta planner.
The upstream runtime had persisted nonempty assistant replies, while Lody repeatedly
failed to drain its ACP buffer with `non-JSON application value`. Sparse, valid tool
notifications acquire explicit `undefined` optional fields in the shared ACP history
applier. The SDK content encoder already applies JSON absence rules, but the native
planner passed inserted items and new nested objects directly to Roost's strict
application JSON conversion. One tool update could therefore block later text too.

Inserted subtrees now share the content encoder's normalization. Object absence is
omitted and array absence becomes `null`, including when diffing an existing array.
Only changed subtrees are encoded; unchanged large bodies retain native deltas.
The continuous test also exposed an independent checkpoint mistake: `applyAgentBatch`
advances the CAS cursor between bounded chunks, so publishing from that mutable cursor
erased the command's change interval. Semantic receipts now retain the command's
initial cursor separately from its current native write guard.

Correction to verification scope: the earlier storage, pure-text and retry checks did
not join valid sparse ACP tool notifications, Native writes and peer incremental body
reads. They were insufficient distribution acceptance. The owning suite now exercises
the real MessageHandler buffer, user/assistant entries, tool start/completion, 31 text
chunks across multiple native batches, JSON-serialized peer RPC bodies and reopen.
Separate native cases cover sparse-tool retry idempotency and nested optional values.
Both encoding regressions failed before the fix with the deployed exception.
These are synthetic local contracts using the installed Native SQLite runtime;
they make no model/network requests and do not claim hosted-agent or browser acceptance.

The [strict peer-reader review](2026-10-16-roost-peer-reader-readiness.md#correction-from-strict-review-reset-is-a-coverage-verdict)
adds the production encrypted RPC endpoints and two renderer replicas to that
consumer chain, including a committed-but-lost native reply. Its discovered reset
fall-through is a renderer recovery defect; no further native write change is
required by that correction.

## Outbox and existing data

Outbox rows are not pending-delivery counts. The installed TypeScript Store's ACK
advances consumer cursors rather than deleting rows; equal update/outbox counts
do not prove that no consumer progressed. Pending bytes require actual consumer
and durable-delivery cursors plus configured remotes.

Lody's renderer uses owner RPC, not independent native replica synchronization.
This repair does not start native upload, invent ACKs, prune signed events or
delete old receipt Turns. It reduces new outgoing payloads by eliminating
snapshot amplification on the hot path; outgoing payload duplication remains an
SDK retention decision.

Existing-data compaction needs a separate verified SDK/storage contract preserving
signed-history verification, recovery, branch state and required replay coverage.
An isolated replacement must be verified before handoff with rollback available.
`VACUUM` cannot remove live receipt/log copies. No actual application database
was modified or cleaned.

## Verification, ownership and alternatives

The owning SQLite contract suite streams 128 distinct Unicode chunks beside a
large unchanged tool result. It verifies final content, fewer than 1000 projection
rows, 128 compact receipts and under 1 MiB of encoded update key/value bytes.
The session then reopens and retries its final stable item without duplicate
output. These budgets are not a database-file-size or wall-clock benchmark.
The final 72-case owner suite passed on the installed Native SQLite implementation,
including scalar-offset middle edits, array changes and multi-operation sealing.
Final cross-module checks and full-run limitations are recorded in the
[peer-reader follow-up](2026-10-16-roost-peer-reader-readiness.md#verification-and-limits).

The same suite covers native committed-but-lost replies, overlapping per-item
retries, conflicting identities, state corrections, permissions, goals, generation
handoff and branch rollback. Mutation ordering and raw write ownership remain
with the existing generation/backend. Cancellation of a caller is not proof that
its write did not commit; durable receipt lookup determines retry outcomes.
Pure delta planning stays ordinary TypeScript, with no Effect runner or version
change. No incomplete Promise wrapper is claimed as a native migration.

Increasing concurrency was rejected because the Native FIFO remains serialized.
Dropping pending receipts or log rows was rejected because it could invalidate
recovery. Extending the SDK remains possible for uncovered write cases, but the
existing atomic API completes this bounded hot-path repair without release changes.

Related decisions: [incremental recovery](2026-10-16-roost-incremental-history.md),
[peer observation](2026-10-16-roost-peer-reader-readiness.md). The existing
[history-write Spec](../../../../specs/session-history-writes.md) remains draft.
No production timing, database migration or deployment is claimed.
