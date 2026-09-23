# Local window bootstrap benchmark

Run from `packages/components`:

```sh
node benchmarks/window-bootstrap/run.mjs 30 > /tmp/window-bootstrap.json
node benchmarks/window-bootstrap/run.mjs 1 --native > /tmp/window-presentation.json
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

## Earlier regression

[Original results](results-2026-09-23.json) retain the 50-sample measurement of the
previous parallel peer/cache race. Its missing-cache path waited 151.50–151.60 ms
before fallback, versus 0.50–0.65 ms for cache-only acquisition. Large-history P95
also regressed in that run. The correction checks live peers, accepts negative
replies, and reads disk before requesting exports. Snapshots still import before
constructing the reader: moving bulk import after reader initialization caused
expensive projection replay in an exploratory run and was rejected.
