# Preserve existing text through Roost producer reshaping

Status: proposed
Type: bug-fix
Translation: current
Owner: Codex
Updated: 2026-10-25

[中文](2026-10-25-roost-producer-text-rewrites.zh.md)

## Abstract

Lody's Roost producer writes unchanged body text again when tag parsing splits an item or a resumed state's accumulated append patch moves within its array. This correction retains the existing node and describes the rearrangement with existing ContentOps, checking the exact target before persistence. In an isolated mixed-workload comparison using published Roost 0.3.0, total database pages decreased from 3,048 to 2,080 KiB; cumulative append CPU and elapsed time decreased slightly, while append p95 increased by 0.024 ms. The reader and data format remain unchanged, and both directions of cross-source reopen passed without migration.

## Defect and correction

The positional array diff turns a parsed text/thought split into a newly inserted body. Separately, an unchanged accumulated append patch moving between state-array slots becomes another complete text Set. These bytes add no conversation information.

The primary planner validates the authored append hint, unique retained span and Unicode scalar offsets, then trims the existing text before inserting surrounding items. The state planner retains an unchanged long patch and reconstructs the exact next patch order around it. Unsupported or unprofitable plans use the existing diff before any write.

Every intermediate primary edit retains the before/after size budget, and the complete staged result must equal the validated target. A per-plan restricted JSON check/cache avoids repeated canonical encoding only where byte length and normalization are equivalent; floats and unsupported representations retain the canonical encoder. A guarded lower bound avoids constructing a duplicate-body diff solely to calculate its cost. Native still owns atomic content/receipt commits, actual operation sequences and seal verification.

This changes pure producer planning and its call site. Published SDK and Native 0.3.0 already support the operations. There is no version, format, dependency, reader, migration, historical rewrite or projection-scheduling change. Existing sealed and unsealed data retain the same reader. Earlier Native format experiments are outside this change and are not dependencies of this result.

## Published-0.3.0 comparison

Baseline: main `2356b8ba327086289561331da4fedf2fdd46c497`. Candidate differs in exactly three runtime files: `roost-content-patches.ts`, `roost-message-state.ts` and their `roost-node-session.ts` call site. Both load the same published SDK/Native 0.3.0 and darwin-arm64 addon SHA-256 `1804d08998328c1ab48121160de767dec84d5f0da4fec42f6581e90ac21acea1`; shared reducer, lockfile and harness are identical. Node 24.22.1, pnpm 10.20.0, darwin/arm64, 1,536 MiB heap limit and unchanged WAL/FULL durability.

Use the existing [durable mixed/resumed workflow](../../../docs/roost-validation.md#choose-a-fixed-manual-benchmark): `ROUNDS=10`, `CHUNKS=100`, `CHUNK_BYTES=1024`, `TOOL_BYTES=16384`, `MIXED=1`. Each fresh database receives the same synthetic content: 20 messages and 1,000 streamed batches, fragmented thinking markup, Unicode, tools/plans and mid-reply finish/reopen. Run A1–B1–B2–A2, with write, fresh-process reopen and paging for every trial. The table gives medians of two complete trials per variant.

| Metric                             |  Before |   After |
| ---------------------------------- | ------: | ------: |
| Total database, KiB                |   3,048 |   2,080 |
| Database growth from empty, KiB    |   2,932 |   1,964 |
| Cumulative append CPU, ms          | 897.086 | 877.636 |
| Cumulative append elapsed time, ms | 624.633 | 606.732 |
| Append p50, ms                     |   0.485 |   0.491 |
| Append p95, ms                     |   1.145 |   1.170 |
| Finish p95, ms                     |   5.418 |   5.220 |
| Process RSS peak, MiB              | 526.695 | 525.891 |
| Process RSS growth since open, MiB | 202.109 | 199.648 |
| Allocated WAL, MiB                 |   4.165 |   4.147 |
| Fresh-process open, ms             | 106.193 | 104.778 |
| First oldest-page read, ms         |   1.003 |   1.034 |
| Full-content read, ms              |  28.697 |  29.582 |

Database totals include Native and Lody control database pages, excluding WAL/SHM. This is fresh-write storage reduction, not automatic shrinking of historical databases. Append CPU/elapsed time cover the 1,000 mutation batches plus their control persistence; creation and finish have separate costs. RSS includes the process, Worker, JS, WASM and Native, and excludes final full-materialization validation. The short history's oldest page is inside the latest window: this is not a long-history recovery measurement. Two trials do not prove a universal speed improvement; p50, p95 and full-read medians are slightly higher. HTTP/Streams offset and a new Loro comparison were not measured.

## Verification and outcome

Root `corepack pnpm check` passed, including 4,573 CLI tests with four existing skips; `corepack pnpm format` and `corepack pnpm run docs check` passed. Behavioral coverage includes Native SQLite, receipt retry, Unicode and malformed scalars, numeric fallback, exact patch order, seals/export, reopen and peer import.

All 12 write/reopen/paging stages plus two correctness-only cross-source reopens passed, with 28 SQLite quick/foreign-key checks and identical content digests. New code reads the old writer's closed seed; old code reads the new writer's closed seed. Source/package/dependency-link hashes stayed unchanged throughout measurement. No live database, paid model request or deployment was used. The decision remains proposed pending review; no blanket performance acceptance is inferred.
