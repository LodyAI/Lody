# Keep operation progress reads and writes local

Status: implemented
Translation: current
PR: [#1629](https://github.com/LodyAI/Lody/pull/1629)

[中文](2026-10-17-local-operation-progress.zh.md)

## Abstract

Coordinator progress updates exported the entire conversation for a preview and again for a changed write. They now select only the operation's system cards, read each card once, and apply validated changes at those stored positions. Content equality also avoids treating Loro object key order as a progress change. Real-Loro regressions forbid unrelated body reads and full-history exports; metadata scans after document changes remain, and each selected legacy-compatible card still needs one detached conversion.

## Decision

The [subagent window fix](2026-10-16-subagent-history-windows.md) covers ACP output, not coordinator operation cards. The new HistoryWriter command retains the existing progress planner and validation rather than implementing a second writer. A metadata directory indexes card ids and system roles; operation count, frontiers and pending transaction length invalidate it for unknown writes, imports, checkout and uncommitted edits. It owns no subscription.

Each selected card is converted at most once per command. This bounded conversion preserves unknown fields and legacy inline data; no full-history fallback exists. Preflight prepares all changes before mutation. Existing containers are updated in place, duplicate removals run backwards, and new cards append after unrelated history. No-op commands return before committing. The equality helper is shared with existing history writes and ignores object key order.

Review correction: the inherited planner skipped identity repair for an unchanged alias-only card, copied metadata from an earlier alias over the canonical card, and repeatedly treated stored extension fields as changes. The planner now prefers canonical metadata, preserves progress/target extensions, and includes the canonical identity in its no-op comparison. The operation-local writer retains the selected container even when renaming a legacy alias; it uses the common replacement validator directly instead of extending the general whole-history write plan with sparse positions. Five regression cases failed on the initial fix and pass with this correction; checkout/pending edits, invalid alias repair, and concurrent same-id creation also exercise the real Loro boundary.

Caching only the old preview would still export unrelated transcripts on each document change. Dropping the preview while retaining the full writer would still scale with total history. Selecting the cards removes both costs without changing storage or completion semantics.

## Verification

The existing shared action suite exercises creation, repeated no-ops, terminal status, duplicate and inline cards, preserved sibling containers/unknown fields, peer imports, pending structural edits, and validation failure before duplicate deletion. Restoring the old route fails with `full history exported`. All 1,518 shared tests pass after review and rebasing onto main. The CLI progress and history storage suites pass 59 tests. Shared type checking, workspace type checking, static boundary/lint checks and formatting pass. The documentation check retains six pre-existing broken links into uninitialized Kimi/Pi submodules, with no new errors. Full `pnpm check` reached 4,286 passing CLI tests and one Git transport failure (`context_unreadable`); the same failure reproduces with the original source. The full repository gate is therefore not claimed green.

A synthetic 512-turn document containing 8.19 MB of text measured 20 updates per path: changed-update median fell from 8.31 ms to 0.46 ms; unchanged-update median from 2.69 ms to 0.012 ms. The first local read, including its metadata scan, took 0.88 ms. The old comparison used the same content-equality fix, so these figures isolate the narrower read/write path. These local measurements do not establish daemon or network latency.
