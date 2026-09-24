# Desktop resource Scout

Scout is an informational soak lane built on the same real Electron harness,
synthetic fixtures, and Page Objects as regression E2E. It is kept out of the
merge gate because process RSS and CPU contain host noise even when product
behavior is deterministic.

## Journeys

| Name      | Repeated lifecycle                                                         | Release evidence                          |
| --------- | -------------------------------------------------------------------------- | ----------------------------------------- |
| `session` | Create Session, stream, stop, archive, permanently delete                  | ACP PID exits                             |
| `review`  | Open Review, switch between two large diffs, hide/show, close, delete      | Review surface and Session close          |
| `work`    | Create worktree Session, run ACP and Terminal, archive, permanently delete | ACP PID, terminal, and worktree disappear |

The default run executes three warmup iterations and 30 measured iterations
per journey. At iterations 5, 10, 15, 20, 25, and 30 it captures the active
state before cleanup, waits for observable resource release, explicitly
collects Electron main and renderer garbage, and captures the post-GC state.

```bash
pnpm e2e:scout
pnpm e2e:scout -- --journey review --iterations 50
pnpm e2e:scout:ablation -- --iterations 12
```

## Measurements

Each checkpoint records Electron main heap/private/RSS, renderer RSS and JS
heap, DOM nodes/documents/listeners, CLI and ACP RSS/CPU/process counts, and
renderer long-task/layout/style/task/layer-paint counters. Process-table
commands are classified in memory and discarded; artifacts contain metrics,
PIDs, and parent PIDs but not raw command lines or environment variables.

The report includes both Theil-Sen slope per checkpoint and a slope normalized
to one user-journey iteration. Only resources with a controllable GC or an
explicit release condition are eligible for candidate classification. CLI RSS
remains in every active and post-cleanup report as an observational working-set
trend: the bundled CLI has no test-only GC protocol, so its allocator high-water
mark cannot be described as a GC-normalized baseline. A candidate requires all
of the following:

- at least four checkpoints;
- a positive Theil-Sen slope;
- net growth above the metric-specific noise floor;
- no decrease across at least 75 percent of adjacent checkpoints; a plateau is
  neutral rather than evidence against a trend.

There is deliberately no absolute memory ceiling. Active-state and cumulative
performance trends are evidence for comparison, not leak classifiers. Relative
growth is reported for ranking but cannot veto a stable slope on a large base.
The runner rejects configurations that produce fewer than four measured
checkpoints instead of reporting an underpowered run as clean.

## Ablation

The ablation command samples every iteration, then writes estimates for no
warmup, two or three discarded iterations, and strides of one, two, and five.
It compares Theil-Sen with ordinary least squares after normalizing both to one
journey. Use it when changing warmup, cadence, noise floors, or the estimator;
do not tune those controls from a single noisy nightly run.

## Triage

A successful Scout may still report suspected trends. CI uploads the complete
round and a separate least-privilege workflow creates or updates one candidate
Issue. The finding stays informational until it reproduces across independent
rounds and retained-path evidence identifies a specific lifecycle defect. Add
only that narrow deterministic reproduction to the blocking regression lane.
