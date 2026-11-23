# Composer file search benchmark

Requires the workspace's Vite and Playwright dependencies plus a Chromium browser.
Install the pinned browser with `pnpm exec playwright install chromium`, or select
an installed Chrome with `BENCH_BROWSER_CHANNEL=chrome`. The runner builds an
isolated production bundle, serves it on an ephemeral loopback port, launches a
fresh headless browser, and removes its temporary build on exit. It does not open
an existing browser profile or inspect real project files.

```sh
BENCH_BROWSER_CHANNEL=chrome node benchmarks/file-search/run.mjs 3 > /tmp/file-search.json
NODE_ENV=test pnpm exec vitest run tests/mention-file-search.test.ts
```

The seeded-by-index fixture contains 1,000, 10,000, and 80,000 synthetic paths with
deep shared directories. Each query (`a`, `comp`, `src/components`, `zz-no-match`)
runs three times in fixed baseline → optimized synchronous → Worker order. The
[frozen baseline](../../tests/fixtures/file-search/baseline.ts) identifies its source
commit and uses the unchanged upstream scoring function. Every result array must
match the baseline exactly. A message-driven check also cancels a real Worker
query and verifies the next query's results before measurements begin.

Output records every sample, browser/Node/CPU information, end-to-end operation
latency, maximum animation-frame callback gap, and callback count. Frame gaps use
callback wall time, not the frame's scheduled timestamp. Index timing is reported
separately: baseline construction versus Worker startup, cloning, construction,
and an empty query. First non-empty queries include metadata preparation. No
warm-up samples are discarded; compare medians and inspect raw samples. Timings
are observations, never CI assertions. Only deterministic result and lifecycle
checks belong in the test suite.

The `optimized-sync` arm isolates algorithm improvements; it deliberately runs on
the main thread and is not the product's execution path. A Worker result can take
longer than a frame without blocking the renderer. These fixtures do not measure
filesystem scanning, React menu rendering, draft hydration, or a whole Electron
session. CPU contention and browser/OS versions affect results.

[Recorded production run](results-2026-09-20.json) and
[decision with measured limits](../../../../.agents/notes/implemented/bug-fix/2026-09-20-composer-file-search-worker.md).
