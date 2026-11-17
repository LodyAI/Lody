# Pull-request Vitest suites narrowed to related tests

Status: implemented
Translation: current

English | [中文](2026-11-17-ci-vitest-related-tests.zh.md)

Earlier: [CI affected tests](2026-09-07-ci-affected-tests.md) selects packages and
rejected Vitest `--changed` as alternative 5. This note revisits that alternative.

## Abstract

Package-level affected selection still runs every test of every dependent
package: a one-file change in `packages/shared` reruns the whole `components`
and `cli` suites. When every changed file in an affected pull-request scope is
an existing module under a `src/`, `test/` or `tests/` directory, the
`components`, `cli` and single-boot rest Vitest runs now use `vitest related`,
so only test files whose import graph reaches a changed file run. Anything
Vitest cannot trace keeps whole suites, and `main` pushes stay full, so a
missed dependency surfaces after merge rather than going untested.

## Decision

- `.github/scripts/related-test-files.mjs` returns the changed files, or null.
  It narrows only an `affected` scope. Markdown is ignored. Config, setup,
  `__mocks__`, fixtures, non-module files, files outside `apps/` and `packages/`,
  ACP submodules and deleted files return null.
- `run-ci-tests.mjs` (CI) and `scripts/run-local-tests.mjs` (local
  `check:affected`) share the helper. Dedicated suites run
  `pnpm --filter <pkg> exec vitest related --run --passWithNoTests` with paths
  relative to the package; the rest group uses `test:rest:related` with the
  same `--project` filters. Shards stay; an empty shard passes.
- Electron, site-docs, repository scripts and other non-Vitest suites keep
  their package-level selection.

## Why alternative 5 no longer loses

The 2026-09-07 rejection cited mixed runners and monorepo-graph blindness.
Narrowing applies only to Vitest suites, so other runners are unaffected. The
graph is not blind: workspace packages resolve to source, and
`vitest related` from `packages/components` selects tests for a changed
`packages/shared/src` file.

Measured on 2026-11-17 (Linux, 8 cores):

| Changed file | Suite | Related / total test files |
| --- | --- | --- |
| `packages/components/src/components/AppInitializer.tsx` | components | 1 / 446 |
| `apps/cli/src/lib/acp-agent-attachments.ts` | cli | 40 / 332 |
| `packages/shared/src/acp-model-capabilities.ts` | shared (rest) | 32 / 84 |
| `packages/shared/src/acp-model-capabilities.ts` | components | 360 / 446 |

Widely imported modules still select most of a suite, so the gain is largest
for leaf changes.

## Consequences

- Effects outside static imports are missed on pull requests: computed dynamic
  imports, files read from disk, and module-registry tricks. `main` and the
  `ci-full` label still run whole suites.
- A changed setup or config file must not be renamed out of the setup/config
  patterns without revisiting the helper.
