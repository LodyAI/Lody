# Build `acp-extension-core` on install, not in each consumer

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/596

Upstream change: https://github.com/LodyAI/acp-extension-core/pull/8

[中文](2026-09-11-acp-core-install-build.zh.md)

## Abstract

`acp-extension-core` ships raw TypeScript plus a compiled `dist/`, and its runtime
`exports.import` points at `dist/index.js`. Only `build` and `prepublishOnly` produced that
directory, so a pnpm workspace install linked the package without compiling it: any consumer
that bundles the runtime export failed with `Failed to resolve entry for package
"acp-extension-core"` unless it ran its own `pnpm --filter acp-extension-core build` first. Five
such workarounds accumulated across `loro-dev/lody` and this repository, and each new consumer
rediscovered the failure. The package now declares `prepare`, which pnpm runs on install as well
as on pack/publish, so workspace consumers get `dist/` from a plain install while the published
tarball is unchanged; `prepare:acp-adapters` no longer compiles Core. Residual limit: an install
that does not include the package in its filter scope still never builds it, so correctness now
depends on the dependency graph rather than on per-job discipline.

## Problem

- `main` and `exports.import` are `./dist/index.js`; `dist/` is gitignored and absent from a
  clean checkout.
- `types` is `./src/index.ts`, so `pnpm typecheck` always passed and only bundlers
  (Vite, esbuild, Wrangler) failed — late, in publish pipelines.
- pnpm's `workspace:*` links the package; it does not run its build.
- `packages/shared` imports runtime values from Core (`createPlanModeConfigOption`,
  `LODY_PLAN_MODE_CONFIG_ID`), so Core's runtime entry reaches the browser bundle, the Convex
  bundle, the Worker, Pages, the CLI, and mobile.

## Decision

Declare `prepare: npm run build` in `packages/acp-extension-core/package.json`, replacing
`prepublishOnly`, which `prepare` supersedes for the pack/publish path. The producer builds its
own runtime entry at install time; consumers stop carrying a build step for a dependency.

Alternatives rejected:

- **Pin every consumer to a published registry version.** It removes the local checkout from the
  build input. `acp-extension-codex` inlines Core into its bundled `dist/`, and the CLI inlines
  Core and all four adapters, so the products would ship whatever npm last published instead of
  the pinned submodule; the adapters already declare three different Core versions
  (0.1.0/0.1.1/0.1.4), which the root `overrides: acp-extension-core: workspace:*` deliberately
  collapses to one copy.
- **Point `exports.import` at `src/index.ts`.** Changes runtime semantics for Node consumers and
  needs a `publishConfig` override plus two resolution conditions.
- **Keep the per-job build steps.** They are correct but live at the wrong layer: every new
  consumer has to rediscover the failure, and local development has no such job.

## Evidence

pnpm 10.20.0 workspace, verified in a scratch workspace and then in `loro-dev/lody`:

- `pnpm install` and `pnpm install --frozen-lockfile` both run a workspace project's `prepare`.
- A filtered install that reaches the package through the dependency closure
  (`--filter '@lody/web...'`, the Cloudflare Pages install) also runs it; `--filter pkg` without
  `...` does not, because the package is outside that install scope.
- `onlyBuiltDependencies` / `ignoredBuiltDependencies` gate external dependency build scripts;
  they do not gate workspace project lifecycle scripts.
- After the change, `acp-extension-core/dist/index.js` appears from a plain root install and the
  mobile production bundle that previously failed in the resolver completes.

## Consequences

`loro-dev/lody` can drop the four per-consumer Core builds (Convex deploy step, site-docs
release step, Pages inputs, mobile publish jobs) and this repository can drop the Core stage from
`prepare:acp-adapters`. An extra `tsc` now runs on every install of the workspace, including
installs that never bundle Core.
