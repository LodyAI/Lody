# Local window bootstrap benchmark

Run from `packages/components`:

```sh
node benchmarks/window-bootstrap/run.mjs 50 > /tmp/window-bootstrap.json
```

Requires the workspace's components dependencies and Electron installation. The
runner launches two isolated Electron renderers with a temporary profile and
removes its build/profile after exit. It never reads product user data. Histories
come from the existing synthetic conversation fixture.

The source renderer owns a real Repo and Session document. The receiver exercises
production BroadcastChannel bootstrap, IndexedDB snapshot reads, CRDT import, and
the production conversation reader through a lease for the last 30 entries.
`before` reproduces the previous cache-only acquisition; `after` invokes the new
peer/cache race. Both use the same history reader. This is a data-path benchmark,
not two full application builds or a click-to-visible-window measurement.

The clock starts immediately before cache acquisition and includes import and
history projection. Repo creation, route initialization, authoritative daemon
synchronization, React rendering, layout, and paint are excluded. Peer metadata
exchange runs concurrently but is not separately timed. Both native windows stay hidden with background throttling disabled.
Each scenario has three discarded warmups, alternating before/after ordering,
and the requested number of measured samples. There are no injected delays.

## Measured result — 2026-09-23

[Machine-readable summary](results-2026-09-23.json) records the production revision,
environment, sample counts, medians and P95. This confirmation run used 50 samples
per variant/scenario/size on Apple M4 Max, macOS arm64, Electron 39.5.1 / Chromium
142. An initial 20-sample run also reproduced the approximately 151 ms miss penalty.

| History entries | Disk hit: before / after median | Peer only: after median | Disk hit: before / after P95 |
| --- | --- | --- | --- |
| 100 | 3.40 / 3.45 ms | 3.10 ms | 4.40 / 4.30 ms |
| 1,000 | 14.05 / 14.20 ms | 14.95 ms | 30.10 / 21.10 ms |
| 3,000 | 39.95 / 40.60 ms | 42.40 ms | 69.20 / 354.20 ms |

These values end at readable history. In the peer-only scenario, the old path
returns no history and must synchronize with the daemon; that downstream time is
not measured, so no speedup percentage is defensible.

When neither cache nor peer has data, the old path reaches synchronization
fallback in 0.50–0.65 ms median. The new path takes 151.50–151.60 ms because store
creation awaits the peer request deadline. Neither variant has readable history
at that point. This is a reproducible regression, not a successful faster open.

The disk-hit medians provide no evidence of improvement. The large-history P95
also regresses in the confirmation run; its cause has not been profiled, and these
small samples do not establish a stable tail distribution. Peer reuse demonstrates
a local route to readable history, but does not establish end-to-end improvement.
The miss penalty remains unresolved in the measured product revision.
