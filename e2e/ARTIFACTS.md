# Verification artifacts

Runtime output is written below ignored `e2e/artifacts/` directories.

| Artifact             | Meaning                                                         |
| -------------------- | --------------------------------------------------------------- |
| `failure.png`        | Full-window state at the failing step                           |
| `trace.zip`          | Playwright actions, DOM snapshots, network, and screenshots     |
| `failure.webm`       | Daily-only recording retained for a failed scenario             |
| `runtime.json`       | Electron, renderer, process, DOM, and memory snapshot           |
| `console.log`        | Timestamped renderer, Electron main, page, and request failures |
| `cli-backlog.json`   | Bundled CLI output exposed through the production IPC service   |
| `failure-index.json` | Stable scenario id to artifact-directory mapping                |

Daily regression sets `LODY_E2E_RECORD_VIDEO=1`. Playwright records each
scenario independently at 640x360, deletes the recording after a clean pass,
and retains `failure.webm` after an assertion or teardown failure. The
read-only Daily job uploads all evidence as one Actions artifact. A separate
trusted reconciler validates the failure index and each video, then attaches up
to one independently retryable comment per failed scenario on the durable Daily
failure Issue. Oversized, missing, symbolic-link, and unexpected-path files are
never attached; the workflow run remains linked for complete trace and log
retrieval.

Acceptance rounds additionally contain `result.json`, `manifest.json`, and a
successful `checkpoint.png` for every selected scenario. Supplied before/after
JSON and retained-path evidence are copied below `evidence/`. The result is
ready for review only when every declared file exists and is non-empty; the
manifest records byte length and SHA-256. A round directory is immutable: rerun
the command to create a new round instead of editing an existing result.

Scout rounds use `scout/<round-id>/summary.json` as the CI discovery contract:

```text
scout/<round-id>/
  summary.json
  <journey>/
    scout-result.json
    runtime.json
    console.log
    ablation.json                 # ablation runs only
    trace.zip                     # failure or suspected trend
    failure.png                   # failure only
    heap/*.heapsnapshot           # failure or suspected trend
```

`summary.json` has `schemaVersion: 1`, a unique `roundId`, `createdAt`, run
`options`, per-journey status/metrics, and a top-level `suspectedTrends` array.
Each metric declares whether it is a `post-gc-candidate` or `observational`
signal. Each journey result retains its active and post-cleanup trend summaries;
raw checkpoints remain in `scout-result.json`. Heap snapshots and traces may be
large and are captured only when they add diagnostic value.
