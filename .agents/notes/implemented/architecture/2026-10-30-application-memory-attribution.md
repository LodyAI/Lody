# Local goal queries for Session GC

Status: implemented
Type: architecture
Translation: current
PR: [#2118](https://github.com/LodyAI/Lody/pull/2118)

[中文](2026-10-30-application-memory-attribution.zh.md)

## Abstract

GC resolves the latest persistent goal to decide whether an idle Session retains its Agent. The local backends now inspect that goal directly. Roost uses its existing goal projection and scans history page by page when the projection is unknown.

## Query semantics

Search messages newest first and each message's items last to first. Select the first `type === 'goal'` with string `threadId`, `objective` and `status`, following the existing resolver. A paused, complete or cleared goal takes precedence over an older active goal; activity remains `status === 'active'`. Confirmed absence enables the legacy metadata fallback, and read failures follow GC's retention path.

Loro inspects container fields synchronously and returns a detached goal. Native Roost reuses the existing projection at a freshly observed cursor, or scans logical pages of 40 messages with the existing state-overlay and segment projection. Pages must be contiguous, and cursor, host and generation must remain consistent across the read. Scanned bodies stay temporary; the validated goal enters the existing memory projection for subsequent checks.

An unknown projection with an old goal or no goal can require every page. First-query work scales with history size; transient storage follows page and individual-record sizes. Fixed first/last-N inspection would miss valid old goals.

## Measurements

Paired fresh processes ran the production local backend and MessageHandler goal check under Electron 44.9.3 / Node 24.22.0 on macOS 27.2 arm64. Source is main `d197e459b9377f7911ec1cf6b21006d8f22fd7c3` plus this implementation; the legacy variant hides the local query capability in the same bundle. Each fixture contains 128 messages of 1 MiB synthetic text. Values below are query increments after backend preparation and explicit GC.

| Metric                                  |  Legacy full read | Local goal query |
| --------------------------------------- | ----------------: | ---------------: |
| Roost extra JS heap, valid projection   | 128.12–128.13 MiB |      About 0 MiB |
| Roost extra JS heap, unknown projection | 128.12–128.13 MiB |    0.11–0.13 MiB |
| Loro extra process footprint            | 119.03–119.06 MiB |      About 0 MiB |

Roost's unknown-projection no-goal case scans four pages in 5.45–5.47 seconds on the first query, then uses the retained goal result in 0.28–0.33 ms. Loro starts with its CRDT already loaded. The query-only measurements distinguish retained JS heap from process footprint.

## Verification

- [Loro boundaries](../../../../packages/shared/tests/session-data-review-boundaries.test.ts) compare supported storage shapes against the complete-history resolver and check body conversion and result isolation.
- [Backend and GC integration](../../../../apps/cli/tests/session-history-targeted-write.test.ts) exercises old goals and in-place clearing through SessionDocument and MessageHandler.
- [Native contracts](../../../../apps/cli/tests/roost-session-backend-contract.test.ts) cover projections, fallback, edits, copying, reopening and concurrent content/generation changes.

Desktop acceptance uses real Electron and bundled CLI with an external synthetic ACP Agent. After 23 completed turns, a goal older than the latest 40 messages retains its Agent while a newer no-goal control is collected; UI clearing then allows collection. Isolated test processes use a 1000 ms idle timeout and 250 ms sweep interval. The [goal-control journey](../../../../e2e/src/features/session-goal.feature) covers the visible goal operations.
