# Composer file search off the renderer thread

Status: implemented
Translation: current

[简体中文](2026-09-20-composer-file-search-worker.zh.md)

## Abstract

File mentions synchronously scored every indexed file and synthesized directory,
sorted every match, then truncated the visible list. An 80,000-file synthetic
project reproduced renderer pauses exceeding a second. File menus now build and
search indexes in a cancellable Worker, publish only current results, and use
bounded selection plus score-only scratch buffers. The production-browser run
reduced the largest measured query frame gap from 1,534.3ms to 17.7ms; broad path
queries still took about one second to finish, so this fixes renderer blocking
without promising instantaneous suggestions.

## Decision

`useMentionFileSearch` owns an active file menu's Worker. Entry identity and query
revision guard publication. Closing or changing the source terminates the Worker;
new text replaces queued work and requests cancellation of running work. The
Worker yields after 512 candidates through a MessageChannel, allowing cancel
messages without timer clamping. Errors remain visible; reopening retries, with
no synchronous search fallback.

The Worker owns normalized paths and precomputed segments. A worst-first heap
retains at most 120 matches, preserving the previous ordering and tie behavior.
The score-only VS Code variant shares character bonuses with the unchanged
position-producing scorer, uses rolling typed-array rows, and first checks that a
matching subsequence is possible. Copyright, license, upstream revision, and
existing generated attribution are retained. The index and scratch buffers die
with the Worker. Other mention categories keep their own ranking paths.

Debouncing alone would reduce frequency without removing long tasks; menu
virtualization would not remove scoring before rendering. Only optimizing the
synchronous algorithm still blocks on broad queries, as the benchmark's middle
arm demonstrates. The Worker adds startup/cloning cost and one index per active
file menu rather than maintaining a cross-project global cache.

The [Spec](../../../../specs/composer-file-search.md) remains draft. This change
implements responsiveness and freshness behavior; it does not claim human Spec
approval. The existing [pipeline](../../../docs/ui-mentions.md) remains the owner
of the wider mention architecture.

## Reproducible evidence

Run instructions, fixture definitions, and methodology are in the
[benchmark README](../../../../packages/components/benchmarks/README.md); the
[raw samples](../../../../packages/components/benchmarks/results/mention-file-search-2026-09-20.json)
include all three repetitions, no discarded warm-up. This run used Apple M4 Max,
macOS arm64, Node 26.8.2, Vite 8.2.2, Playwright 1.58.2, and headless Chrome 153. The production build runs the real
Worker and checks every result against the frozen pre-change implementation.

For 80,000 synthetic files, median completion time and maximum frame callback gap:

| Query            | Baseline latency | Optimized sync latency | Worker latency | Baseline max gap | Worker max gap |
| ---------------- | ---------------: | ---------------------: | -------------: | ---------------: | -------------: |
| `a`              |          442.1ms |                 90.4ms |         72.3ms |          451.5ms |         17.7ms |
| `comp`           |          739.7ms |                323.7ms |        316.4ms |          740.9ms |         17.6ms |
| `src/components` |         1530.8ms |                978.2ms |        959.7ms |         1534.3ms |         17.6ms |
| `zz-no-match`    |          741.5ms |                 32.5ms |         27.4ms |          746.1ms |         17.4ms |

Cold baseline indexing took 215.9ms on the renderer. Worker startup, transfer,
indexing and an empty query took 210.6ms end to end with a 17.2ms maximum frame gap.

## Verification and limits

The 17 affected/neighboring mention suites passed all 192 tests on Node 22.23.2
with Vitest 3.2.4. Strict standalone typechecking of the six search/worker modules,
scoped Oxfmt/Oxlint checks, and the Vite 8.2.2 production Worker build passed.
Full component typechecking is blocked by unavailable workspace dependencies
(including Electron) and unrelated diagnostics in this checkout. The final docs
check has 11 pre-existing broken links to uninitialized Codex/Grok submodules;
none concern the changed documentation. No full Electron build or UI profile was
performed.

Tests compare ordering and limits with the baseline, compare score-only output
with upstream scores across deterministic Unicode/separator inputs, exercise
query coalescing/cancellation, failures, source switches, close/reopen and unmount,
and cover loading groups, first-result keyboard highlighting, and insertion through the actual composer. The browser
runner separately verifies a real cancellation followed by a successful query.

File enumeration, IPC payload transfer, synchronous draft hydration, and full
Electron-window behavior are outside the measured harness. Initial index transfer
still costs main-thread serialization; cancellation is cooperative between
candidate batches, not preemption within one unusually long path's score. The
fixture and current machine are evidence of this fix, not universal latency bounds.
