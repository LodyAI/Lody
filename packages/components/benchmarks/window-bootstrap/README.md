# Local window bootstrap benchmark

Run from `packages/components`:

```sh
node benchmarks/window-bootstrap/run.mjs 30 > /tmp/window-bootstrap.json
node benchmarks/window-bootstrap/run.mjs 1 --native > /tmp/window-presentation.json
# Requires a built desktop and resources/cli, all from a known revision:
node benchmarks/window-bootstrap/run-app.mjs 5 current > /tmp/window-app.log 2>&1
# Optional fourth argument: conversation rounds (two entries each).
node benchmarks/window-bootstrap/run-app.mjs 5 short 50 > /tmp/window-app-short.log 2>&1
```

Requires components dependencies and Electron. The runner uses two isolated
renderers and a temporary profile, deletes its build/profile afterward, and never
reads product user data. Histories use the existing synthetic conversation fixture.

## Boundaries

The source owns a real Repo and Session document. The receiver exercises production
BroadcastChannel, Web Locks, IndexedDB, CRDT import and the conversation reader
through a lease for its last 30 entries. `before` reproduces cache-only acquisition;
`fixed` uses the current disk-first, live-peer-aware bootstrap. Both use the same
reader. This is a data-path comparison, not two full application builds.

Acquisition starts immediately before cache access. `readableMs` includes import
and history projection; `syncReadyMs` ends once the foreground store can start
normal synchronization. No daemon is contacted. Repo creation, route initialization,
authoritative synchronization, React rendering/layout and paint are excluded. Peer
metadata exchange is concurrent and not separately timed. Both native windows are
hidden with background throttling disabled. Each scenario discards three warmups,
alternates variant order and records the requested sample count without injected
delays. Source hashes accompany results.

`--native` runs the production main presentation and renderer readiness helpers.
It requests a 3,000-entry peer snapshot, projects the last 30 rows into a synthetic
DOM surface, signals readiness after two frames, and checks/captures the first
native `show`. Its `claimToShowMs` begins at `presentWindowTarget`, not at a user
click. The screenshot path is returned in JSON. This verifies hidden preparation
and presentation ordering; it does not validate the full Lody React interface.

## Corrected measurement — 2026-09-23

[Corrected results](results-fixed-2026-09-23.json): 30 samples per variant/scenario/size,
Apple M4 Max, macOS arm64, Electron 39.5.1 / Chromium 142.

| Entries | Disk hit: before / fixed median | Peer only: fixed median | Disk hit: before / fixed P95 |
| --- | --- | --- | --- |
| 100 | 4.20 / 4.50 ms | 4.40 ms | 4.70 / 8.40 ms |
| 1,000 | 16.15 / 16.40 ms | 17.50 ms | 29.00 / 32.60 ms |
| 3,000 | 39.55 / 39.50 ms | 41.80 ms | 71.60 / 60.70 ms |

The table ends at readable history. In the peer-only scenario the baseline has no
history and needs unmeasured daemon synchronization; no overall speedup percentage
is claimed. Disk-hit medians remain approximately equal, without unnecessary peer
exports. Samples are too small to establish a stable tail distribution.

With neither data source available, corrected acquisition takes 0.20 ms median and
the store is ready to synchronize in 0.20–0.30 ms. There is no unconditional peer
response deadline on that path. Live peers explicitly replying that a document is
absent are separately covered by deterministic tests. An inventoried peer that
subsequently stalls or exits still has a 150 ms bounded timeout.

The native probe recorded 152.39 ms from claim to first show. The window was hidden
before content, and its first shown capture contained all 30 projected rows. This
single synthetic sample is not an application opening-time distribution.

## Real desktop verification — 2026-09-23

`run-app.mjs` runs the built desktop with fresh, isolated user data and a short
Unix-socket data directory. It imports the synthetic fixture into the source Repo,
opens it in the real conversation UI, enables the production warm pool, and claims
successive spares through `app.openWindow`. Each spare has at least 1.5 seconds of
preparation before measurement; this lead time is outside the timed interval.
The probe captures each native `show`, checks the matching marker, actual stream
visibility and final synthetic answer, and closes the window normally. Three
warmups are discarded. Logs, screenshots, results and build hashes remain under
the printed `/tmp/lody-app-bench-*` directory; no product profile is used.
Set `PROBE_CPU_PROFILE=1` to retain a Chromium CPU profile for each claim.
The timer starts at `app.windowTarget` dispatch, so it excludes physical input and
source-window IPC dispatch. It includes target React rendering and initial scroll.

[Recorded comparison](results-app-2026-09-23.json) used the same bundled CLI 0.93.3
with current desktop source. Only the runtime-provider change was removed for the
baseline. Runs were sequential with separate fresh profiles, not alternating trials.

| Renderer | Samples | Median claim to show | Range |
| --- | --- | --- | --- |
| Before workspace preinitialization | 5 | 820.30 ms | 812.81–848.28 ms |
| With workspace preinitialization | 10 | 1,057.22 ms | 1,038.96–1,356.23 ms |
| With preinitialization and visible-stream readiness | 5 | 1,140.84 ms | 1,102.16–2,708.94 ms |
| Repeated with committed real-app runner | 5 | 1,139.32 ms | 1,118.41–1,162.37 ms |
| Seed cold storage before Repo adoption | 5 | 700.14 ms | 689.76–719.29 ms |
| Also preload workspace layout code | 5 | 430.77 ms | 424.24–463.15 ms |
| Same optimized path, 100 entries | 5 | 256.56 ms | 248.05–261.43 ms |

Preinitialization worked: every sampled spare already had its Repo and target
metadata before claim, and claim did not recreate its runtime. It alone did not
improve latency. It also exposed a readiness bug: the
[preinitialization-only capture](app-first-show-hidden.png) contained chrome but no
visible conversation despite the old ready marker. The virtual list hid its
viewport until initial scroll restoration. The corrected gate waits for the stream;
the [corrected first-show capture](app-first-show-visible.png) contains the answer.

CPU profiles then identified expensive bulk import into an already subscribed Repo
document. Seeding and durably saving a cold replica before Repo adoption reduced
the median to 700.14 ms. Preloading workspace layout code and rendering the resolved
component directly removed an initial lazy/Suspense wait, reducing it to 430.77 ms:
62% below the 1,139.32 ms visible-stream baseline. Existing live documents still merge
in place; preload does not mount workspace UI. These changes retain the same visible
stream gate. All eight captures per optimized run passed readiness, answer visibility,
and absence of Loading/Session Not Found, including three discarded warmups.

This is measurable improvement, not instantaneous opening. The short-history run
still takes 256.56 ms; target-specific history/rendering and native presentation
remain after claim. The earlier 152.39 ms synthetic-DOM probe did not exercise this
React lifecycle. One earlier baseline process crashed before completion and was
excluded; its replacement run completed. These small sequential samples and the
earlier outlier cannot establish a stable tail distribution.

## Earlier regression

[Original results](results-2026-09-23.json) retain the 50-sample measurement of the
previous parallel peer/cache race. Its missing-cache path waited 151.50–151.60 ms
before fallback, versus 0.50–0.65 ms for cache-only acquisition. Large-history P95
also regressed in that run. The correction checks live peers, accepts negative
replies, and reads disk before requesting exports. Snapshots still import before
constructing the reader: moving bulk import after reader initialization caused
expensive projection replay in an exploratory run and was rejected.
