# Conversation replay (Node, no browser)

Run from the repository root after installing workspace dependencies (uses the CLI's pinned `tsx`).

```sh
node packages/components/benchmarks/replay/run.mjs --out /tmp/replay-baseline
# Optional: reuse a LOCAL sanitized snapshot instead of generating synthetic data
node packages/components/benchmarks/replay/run.mjs --fixture /absolute/path/history.snapshot --runs 3 --out /tmp/replay-baseline
```

The default synthetic input contains 1000 user rounds / 2000 entries, produced through the real HistoryWriter with deterministic high-entropy prose and tool content. Fixture generation and file IO are outside phase timings. Never commit captured conversation data, sanitized local assets, profiles or results. Default artifacts stay in `/tmp`.

Every measured iteration is a fresh Node process: snapshot import -> production createConversationSession -> initial directory -> last-30 lease -> deferred tail hydration (offscreen summaries stay unread) -> on-demand outline preview -> 20 alternating window jumps -> append -> 30 growing text updates -> drain -> release/dispose. The loop includes actual production reader, writer, cache, summaries, identity index and event propagation. It does not include React, JSX allocation, DOM layout, Virtua scrolling, HTTP transfer or rendering. It cannot certify frame time or replace the final browser smoke test.

`committed` commits the session-id initialization before opening; `pending` intentionally retains it, reproducing the trace's unrelated pending-transaction condition. It does not change the production index guard. Both use the same snapshot. Modes alternate order across repetitions.

## Outputs and profiling

- `baseline.json`: raw runs, per-stage min/median/max, input SHA256, Node version, source revision/dirty-diff hash, source and runner fingerprints.
- Individual run JSON: wall time, CPU time, memory snapshots per phase, idle chunk durations, per-update latency, hydrated count and correctness checks.
- Memory is process-level Node RSS/heap/external, not a browser/WASM retained-memory guarantee. Post-dispose GC does not imply all native memory returned to the OS.
- Three samples establish an initial baseline, not a confidence interval. Keep machine load and other active profiling stable. Never run timing and profile jobs concurrently.

```sh
# Separate recording: inspector starts AFTER TS imports and fixture file IO.
node packages/components/benchmarks/replay/run.mjs --fixture /absolute/path/history.snapshot --mode pending --runs 1 --profile --out /tmp/replay-profile
node packages/components/benchmarks/replay/profile.mjs /tmp/replay-profile/pending-0.cpuprofile
# Inspect without Chrome, or later open the standard .cpuprofile in DevTools.

# Diagnostic instrumented run; do not compare its timing against uninstrumented runs.
node packages/components/benchmarks/replay/run.mjs --fixture /absolute/path/history.snapshot --runs 1 --counters --out /tmp/replay-counts

node packages/components/benchmarks/replay/compare.mjs /tmp/replay-baseline/baseline.json /tmp/replay-after/baseline.json
```

`--idle-budget-ms 50` is the default monotonic elapsed-time allowance per queued idle callback, approximating the captured idle budget, not a browser scheduler. Try `4` as a separate scheduling experiment. Same operation order/input, variable work per idle chunk. Controlled setImmediate yields let actual promise/event propagation run; no guessed sleeps are used for correctness. The parent enforces a 180-second child timeout.

Assertions verify membership, every acquired window's IDs, absence of unsolicited offscreen summaries, appended turn and each streamed text value. Errors/timeouts/nonzero child exits fail the run; no final successful baseline is written. Do not reuse an output directory from an earlier success after a failed run.

After an optimization: rerun the unchanged replay with identical fixture, options and Node version; compare both modes; run existing uncommitted insert/delete/reorder/ID-change correctness regressions too. Improving this loop alone does not prove concurrent-write compatibility. No product behavior is modified by these tools.

Outline lazy-loading changes the workload: `idleTail` replaces the old full-summary phase. Do not compare these baseline files with the old runner as if they measured identical work. The initial directory and retained tail remain; preview bodies are requested by hover/window leases. Business fact derivations are not mounted in this Node replay.

## Large-turn foreground catch-up

`resume.ts` prepares the same deterministic snapshot and thirty small remote text
updates, warms the production view, and replays the updates into its retained turn.
The default turn has 1,200 completed tools with 8 KiB of synthetic output each.
Each checkout uses its own installed Loro instance. The measured range is acquired
after the initial directory is ready.
It reports import time, display-body read time, time to the updated view, and delay
until another Node task can run. The fixture hash must match between comparisons.

Run the unchanged runner against two checkouts with installed dependencies:

```sh
node --import ./apps/cli/node_modules/tsx/dist/loader.mjs packages/components/benchmarks/replay/resume.ts /absolute/path/to/baseline > /tmp/resume-before.json
node --import ./apps/cli/node_modules/tsx/dist/loader.mjs packages/components/benchmarks/replay/resume.ts . > /tmp/resume-after.json
```

Run timing samples sequentially, without other tests/profilers. `RESUME_TOOLS`
changes the fixture size; use the same value for both checkouts. `RESUME_UPDATE_KIND=append`
appends separate text items instead of growing the last text, exercising list invalidation.
Compare the same update kind on both checkouts. Results also fingerprint the runner,
source files and lockfile. Setup, first body
hydration and file IO are outside the measurement. Each run checks that every remote
text update reaches the view. These Node measurements exclude React, DOM/layout,
browser frame scheduling and real network; next-task latency is not INP or proof
of a smooth application return. Device acceptance must still exercise returning to
a conversation while typing and scrolling during actual catch-up.
