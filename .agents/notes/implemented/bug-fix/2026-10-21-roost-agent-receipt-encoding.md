# Compact retained Roost agent receipts

Status: implemented
Type: bug-fix
Translation: current
Date: 2026-10-21

[中文](2026-10-21-roost-agent-receipt-encoding.zh.md)

## Abstract

Lody stored each agent notification's replay identity and content digest as JSON,
using 248 bytes for a UUID-based receipt. The new local index retains every
identity and all digest bits in 82 bytes, without changing history transactions,
signed updates, outbox retention or Roost itself. In a synthetic whole-session
comparison, median SQLite growth fell from 744 to 554 KiB (25.5%); this is a disk
result, not a claim about process memory or network traffic. The experimental
format deliberately has no old-format reader or migration: sessions containing
v1 agent receipts are rejected and must be replaced by new sessions.

## Format and correctness boundary

`roost-content-patches.ts` owns the v2 codec. A canonical lowercase UUID,
`publication` kind and `agent:<64 lowercase hex>` segment use tag 0, the complete
16-byte UUID and the complete 32-byte operation digest. Other supported identities
use tag 1 followed by the existing canonical application JSON encoding. These
representations are disjoint; uppercase IDs, extra fields, newlines and non-UUID
IDs are never normalized into another identity. Invalid Unicode remains rejected
by the existing canonical encoder. Values contain version byte 2 and all 32 bytes
of the content digest; invalid length or version throws instead of becoming a miss.

`roost-history-generation.ts` reads only `lody_agent_operation_receipts_v2`.
A one-row v1 namespace presence check, cached for the stream handle's lifetime,
rejects old or mixed generations before owner initialization, recovery or writes.
It does not decode, convert or delete old records. New sessions in the same database
remain independent. An upgrade requires retiring the previous CLI owner; writing
one database with old and new binaries concurrently is not supported.

The existing atomic content-edit/index transaction, retry/conflict checks and
current/ancestor lookup order remain intact. Structural operations still use the
SDK's current receipt path; this is not a legacy-format fallback. No receipt,
projection, signed frame or outbox entry is pruned. Notification batching, flush
timing, FULL/WAL durability and package versions are unchanged. Pure encoding and
a bounded check fit the existing Promise-based Native owner; no lifecycle or
Effect migration is part of this change.

The [streaming-write decision](2026-10-16-roost-storage-write-amplification.md)
defines the retained receipt contract. This change supersedes only its local
receipt encoding, separately from [SDK message-state copies](2026-10-20-roost-message-storage-copies.md).
Outbox references would require a separate Roost core change and are not included.

## Validation and measurement

The four owning suites pass 104 tests. Added cases exercise exact identities,
malformed values, old/mixed format rejection without deletion, content-plus-receipt
rollback after a later native guard fails, a lost reply after committing the first
30 items of a 65-item command, overlapping retries after reopening, conflicting
payloads and receipt discovery after branch removal and generation replacement.
The existing streaming test now uses a UUID and verifies all 128 receipts occupy
exactly 128 × 82 bytes while retaining its unchanged-body/reopen assertions.

The manual benchmark runs the actual Lody adapter on Native 0.2.0 with fresh SQLite
databases. Its baseline is public commit `a8cffe6f1be2a7b6983770afdebe5231b0a7ae10`.
It applies two exchanges (four logical messages), 40 synthetic tools, 917
notifications in 224 batches and then reopens the database. Final JSON is 46,409
bytes. Each exchange has 20 pending/in-progress/completed execute tools with
512-byte synthetic terminal output, followed by text chunks. Each exchange's
459/458 notifications are partitioned into 112 batches using integer boundaries.
Four macOS arm64 processes run baseline/compact/compact/baseline, each discarding
one warmup and measuring four fresh databases: eight observations per variant.
SQLite growth is the change in `page_count × page_size`; transient WAL/SHM, the
separate identity database and Loro control storage are excluded in both variants.

| Metric | Baseline | Compact |
| --- | ---: | ---: |
| Receipt count | 917 | 917 |
| Receipt KV bytes | 227,416 | 75,194 |
| Total SQLite growth, median | 744 KiB | 554 KiB |
| Total SQLite growth, range | 736–748 KiB | 540–568 KiB |
| Whole write workload, mean / median | 1622.9 / 1548.6 ms | 1470.6 / 1327.9 ms |
| Process CPU, mean | 1603.6 ms | 1476.3 ms |
| Complete read, mean / median | 9.19 / 7.26 ms | 11.08 / 6.32 ms |
| Reopen plus complete read, mean / median | 37.80 / 36.46 ms | 39.63 / 33.58 ms |

Every run produced identical logical history before and after reopen. Both variants
retain 272 signed-update rows (76,960 KV bytes) and 272 outbox rows (72,608 KV bytes).
Read/reopen means include compact outliers of 44.3/83.9 ms; this noisy local sample
establishes storage savings, not a universal latency guarantee. It is a synthetic
replay, not the original live transcript or a deployment: do not present 554 KiB as
a measured replacement for the previously observed 804 KiB session. Earlier
same-tuple SQLite layout probes independently saved 168–220 KiB. Actual workload,
notification count and page layout determine the total reduction. Captured user
content and benchmark databases remain outside the repository; the manual timing
workload is not added to CI.

## Validation against the next Native storage format

The separate Roost Native change disables an unused generic outbox while retaining
the update log, event journal and durable remote-sync work ledger. Lody already
uses those Native APIs; no alternate runtime integration is required. Two
footprint assertions treated every container other than v4 as the removed v3
schema. They now query the interned namespace tables directly, as both published
Native 0.2.0 and the candidate use that layout. Content, immutable-log, receipt-size
and bounded-projection assertions remain; Native owns its version-gate tests.

With `NAPI_RS_NATIVE_LIBRARY_PATH` selecting the candidate release addon, all 86
adapter contract tests pass, including uncertain commits, restart, replay,
pagination and sealed-history changes. The full repository `pnpm check`, format
and docs checks also pass with the normal pinned dependencies. This validation
does not change a package version or deploy either repository; the Native
optimization still needs a coordinated release and an explicit dependency update.
