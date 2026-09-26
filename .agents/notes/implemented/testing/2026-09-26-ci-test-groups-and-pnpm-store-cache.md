# CI test groups on separate runners and a main-only pnpm store cache

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/992

English | [中文](2026-09-26-ci-test-groups-and-pnpm-store-cache.zh.md)

## Abstract

The `Tests` job took 6–11 minutes. Most of that was the `@lody/components`
suite (≈351 s) followed by `apps/cli` (≈158 s), in one job on a 4-vCPU runner.
Letting the two suites overlap in that job (`pnpm -r --no-sort`) did not help:
the runner is CPU-saturated, so the overlapped suites took 509 s and 252 s.
`Tests` is now a matrix: three Vitest shards of components, cli, and the rest,
each on its own runner, with an aggregate job that keeps the required `Tests`
check. In addition, `setup-node`'s pnpm cache matched only the exact lockfile
key and let each PR write its own ~800 MB copy. A composite action now
restores the store with a prefix fallback, and only `main` writes it.

## Evidence before the change

From the step timings of main run `36207090914` and PR runs of 2026-09-26:

| Item | Observation |
| --- | --- |
| `Tests` › `Run tests` | 354–591 s. Critical path of `CI`; `Static checks` is ~3 min. |
| `@lody/components` | 351 s, 500 files. Collect 377 s and environment 97 s of CPU, against 91 s of test bodies. |
| `apps/cli` | 158 s, started at 01:11:37, right after components ended at 01:11:32. |
| Dependency chain | `apps/cli → @lody/code-review-helper → @lody/components`, so pnpm's default topological order serialized them. |
| Linux pnpm cache | `pnpm cache is not found` on every run after a lockfile change. `setup-node` has no prefix fallback. |
| macOS pnpm cache | Desktop E2E runs only on `pull_request`, so no macOS entry ever existed on `main`. Every PR's first run missed: install 102 s, then 74 s saving 786 MB. |
| Cache quota | 12 entries of ~800 MB each (~9.6 GB of 10 GB). Per-PR entries, which no other PR can read, pushed out the `main` entries. |

## Correction: overlapping the suites in one job does not help

The first attempt kept one job and added `--no-sort`. On an 18-core machine,
the recursive pass dropped from 198 s to 120 s. In CI (PR #992, run
`36211393445`) the suites did overlap, but components took 509 s and cli 252 s.
The job's `Run tests` step took 537 s, which is within the old range. The
runner's four vCPUs, not the ordering, were the limit. `--no-sort` remains in
the root `test:ci` and in the `rest` group, where it helps multi-core machines
and costs nothing, but it is not what shortens CI.

## Decisions

1. **Split `Tests` into runner-level groups** (`.github/scripts/run-ci-tests.mjs`
   `--group`):
   - `components`: three shards, `vitest --shard=k/3 --maxWorkers=4`.
   - `cli`: `--maxWorkers=4`.
   - `rest`: `test:scripts`, every other package, then electron.

   Each group plans its own commands from the affected scope, and skips install
   when it owns no listed package. Missing or invalid scope output still falls
   back to a full run. The YAML override for CI-definition changes passes
   `--full`. A final `Tests` job `needs` the matrix and succeeds only if the
   matrix succeeded, so the required check name is unchanged.
2. **`.github/actions/setup-workspace`** replaces `pnpm/action-setup` plus
   `setup-node` `cache: pnpm` in `ci.yml` and the Desktop E2E workflows. It uses
   `actions/cache/restore` with key
   `pnpm-store-v1-<os>-<arch>-<lockfile hash>` and a
   `pnpm-store-v1-<os>-<arch>-` prefix fallback. With a stale store, pnpm
   downloads only the missing packages.
3. **`.github/workflows/pnpm-store-cache.yml` is the only writer.** It runs on
   `main` pushes that change the lockfile or the cache definition, and on
   manual dispatch. It covers Linux, macOS and Windows, and it prunes the store
   before saving. It is not a required check, so its `paths` filter does not
   conflict with the no-`paths` rule for `ci.yml`.

## Trade-offs and alternatives

- Five test runners instead of one. Each pays ~70 s of checkout, restore,
  install and adapter setup, so total runner minutes rise. Standard runners are
  free for this public repository. Unaffected groups skip their install.
- **Reducing components per-file overhead** (`isolate: false`, lighter setup).
  This is still the largest CPU cost, and remains open. It risks leaking state
  between test files. See [components test module graph](2026-09-10-components-test-module-graph.md).
- **Caching `node_modules`.** Not done: install with a warm store is 16–40 s.

## Verification

- Locally, each group was run with `--full`. All passed; the three shards cover
  168 files each, and `rest` ran exactly the previous package set minus
  components and cli.
- CI timings for the split and the cache restore are recorded in PR #992.

## Limits

- Until the first `main` run of `pnpm-store-cache.yml`, no `pnpm-store-v1-*`
  entry exists, so PR runs install cold. The old `node-cache-*` entries age out
  after seven days without access.
- `e2e-scout.yml` checks out the default branch, so it uses the composite action
  only after this change is merged.
- Vitest shards split by file, not by duration, so shard times can drift apart
  as suites grow.
