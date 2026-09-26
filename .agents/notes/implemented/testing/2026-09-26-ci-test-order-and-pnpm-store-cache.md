# CI test order and a main-only pnpm store cache

Status: implemented
Translation: current
PR: pending

English | [中文](2026-09-26-ci-test-order-and-pnpm-store-cache.zh.md)

## Abstract

The `Tests` job took 6–11 minutes, mostly because `apps/cli` tests (≈158 s)
started only after the `@lody/components` suite (≈351 s) finished. pnpm runs
recursive scripts in dependency order, and `apps/cli` depends on components
through `@lody/code-review-helper`. Running the recursive test pass with
`--no-sort` lets the two suites overlap. Separately, `setup-node`'s pnpm cache
matched only the exact lockfile key and let every PR write its own ~800 MB
copy. As a result, every lockfile change was a cold install, and Desktop E2E on
macOS never found a cache. A composite action now restores the store with a
prefix fallback, and only `main` writes it. Measured effects are in
[Verification](#verification).

## Evidence before the change

From the step timings of main run `36207090914` and PR runs of 2026-09-26:

| Item | Observation |
| --- | --- |
| `Tests` › `Run tests` | 354–591 s. Critical path of `CI`; `Static checks` is ~3 min. |
| `@lody/components` | 351 s, 500 files. Collect 377 s and environment 97 s of CPU, against 91 s of test bodies. |
| `apps/cli` | 158 s, started at 01:11:37, right after components ended at 01:11:32. |
| Dependency chain | `apps/cli → @lody/code-review-helper → @lody/components`, so the default topological order serialized them. |
| Linux pnpm cache | `pnpm cache is not found` on every run after a lockfile change. `setup-node` has no prefix fallback. |
| macOS pnpm cache | Desktop E2E runs only on `pull_request`, so no macOS entry ever existed on `main`. Every PR's first run missed: install 102 s, then 74 s saving 786 MB. |
| Cache quota | 12 entries of ~800 MB each (~9.6 GB of 10 GB). Per-PR entries, which no other PR can read, pushed out the `main` entries. |

## Decisions

1. **`--no-sort` on the recursive test pass** in `test:ci` and
   `.github/scripts/run-ci-tests.mjs`. Tests do not need build order, since each
   Vitest run transforms workspace sources itself. Concurrency and `--maxWorkers`
   stay unchanged, so this is a scheduling change only.
2. **`.github/actions/setup-workspace`** replaces `pnpm/action-setup` plus
   `setup-node` `cache: pnpm` in `ci.yml` and the Desktop E2E workflows. It uses
   `actions/cache/restore` with key
   `pnpm-store-v1-<os>-<arch>-<lockfile hash>` and a
   `pnpm-store-v1-<os>-<arch>-` prefix fallback. With a stale store, pnpm
   downloads only the missing packages.
3. **`.github/workflows/pnpm-store-cache.yml` is the only writer.** It runs on
   `main` pushes that change `pnpm-lock.yaml` (or the cache definition), and on
   manual dispatch. It covers Linux, macOS and Windows, and it prunes the store
   before saving so prefix fallbacks do not grow it forever. This workflow is not
   a required check, so its `paths` filter does not conflict with the
   no-`paths` rule for `ci.yml`.

## Alternatives not taken now

- **Matrix-split `Tests` (components shards, cli, rest).** This would cut the
  critical path further, to an estimated ~4 minutes. It needs the affected-scope
  selector to map packages to shards, and a `Tests` aggregate job to keep the
  required check name. Deferred to its own change.
- **Reducing components per-file overhead** (`isolate: false`, lighter setup).
  This is the largest remaining cost, but it risks leaking state between test
  files. See [components test module graph](2026-09-10-components-test-module-graph.md).
- **Caching `node_modules`.** Install with a warm store is 16–40 s. Not worth
  the invalidation risk with submodule workspaces.

## Verification

Local (18 cores, same `--workspace-concurrency=2 --maxWorkers=2`), the
recursive pass took 198 s sorted and 120 s with `--no-sort`; all suites passed.
CI before/after timings are recorded in the PR.

## Limits

- Until the first `main` run of `pnpm-store-cache.yml`, no `pnpm-store-v1-*`
  entry exists, so PR runs install cold. The old `node-cache-*` entries age out
  after seven days without access.
- `e2e-scout.yml` checks out the default branch, so it uses the composite action
  only after this change is merged.
