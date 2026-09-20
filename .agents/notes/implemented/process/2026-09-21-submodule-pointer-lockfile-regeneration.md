# Regenerating the lockfile after a submodule pointer bump

Status: implemented
Translation: current

[中文](2026-09-21-submodule-pointer-lockfile-regeneration.zh.md)

## Abstract

CI checks out every submodule recursively and runs `pnpm install
--frozen-lockfile`, but `packages/acp-extension-claude` is inside the root pnpm
workspace (`packages/*`, and `apps/cli` depends on it via `workspace:*`), so its
`package.json` is part of the graph the lockfile must match. Commit `ac8b2c3a`
moved that pointer to a newer upstream commit whose dependency versions had been
bumped, without regenerating `pnpm-lock.yaml`. `main` has been red on the
install step ever since, before any Typecheck, Lint, or test runs. The fix is
to regenerate the lockfile and grandfather the versions that are still inside
the `minimumReleaseAge` window, exactly as the existing entries in that list do.

## Decision

- Regenerate `pnpm-lock.yaml` with `pnpm install --no-frozen-lockfile` after any
  change to a submodule pointer that is part of the workspace, in the same
  commit. The failure mode is total: `--frozen-lockfile` aborts the install, so
  Static checks, Tests, and Desktop E2E all fail at their first step and never
  reach a real assertion.
- A version the submodule newly requires may be inside the seven-day
  `minimumReleaseAge` window. Grandfather it with an exact `name@version` entry
  in `minimumReleaseAgeExclude`, which is what that list already exists for.
  Reverting the submodule pointer, or excluding the submodule from the
  workspace, were rejected: the pointer bump carries the upstream product
  changes, and `apps/cli`'s `workspace:*` dependency requires the package to
  resolve inside the graph.

## Evidence

The mismatch on `main` at `fe12e901` (`pnpm install --frozen-lockfile`):

```text
ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because
pnpm-lock.yaml is not up to date with packages/acp-extension-claude/package.json
  10 dependencies are mismatched
  - @agentclientprotocol/sdk (lockfile: 1.3.0, manifest: 1.4.0)
  - @anthropic-ai/sdk         (lockfile: 0.117.1, manifest: 0.126.0)
  - @tsconfig/node22          (lockfile: 22.0.5, manifest: 22.0.6)
  - @types/node               (lockfile: 26.2.0, manifest: 26.5.1)
  - @typescript-eslint/eslint-plugin (lockfile: 8.67.0, manifest: 8.70.0)
  - @typescript-eslint/parser (lockfile: 8.67.0, manifest: 8.70.0)
  - eslint                    (lockfile: 10.8.1, manifest: 10.10.0)
  - globals                   (lockfile: 17.11.0, manifest: 17.12.0)
  - prettier                  (lockfile: 3.9.6, manifest: 3.9.7)
  - vitest                    (lockfile: 4.1.10, manifest: 5.0.1)
```

Timeline: `a870b1b1` (2026-09-17) last regenerated the lockfile; `ac8b2c3a`
(2026-09-20) moved `packages/acp-extension-claude` to `56b94c6c`; the pointer is
identical on `main`, so no branch introduced the mismatch.

Seven of the ten versions were already older than seven days. Three roots and
the `@vitest/*` release train were not, and are the only additions to
`minimumReleaseAgeExclude`:

- `@anthropic-ai/sdk@0.126.0`
- `prettier@3.9.7`
- `vitest@5.0.1` and its `@vitest/{expect,mocker,pretty-format,runner,snapshot,spy,utils}@5.0.1`

`@agentclientprotocol/sdk@1.4.0` was initially added and then removed again
once its publish date was checked — it is well past the window and must keep
resolving under the normal policy.

## Verification

`pnpm install --frozen-lockfile` now completes. With the regenerated lockfile:
`pnpm format:check`, `pnpm typecheck`, and `pnpm check:quick` pass;
`@lody/components` reports 3761 passing tests across 478 files. The lockfile
diff is confined to those dev toolchains and their transitive edges
(eslint 10.10.0, globals 17.12.0, prettier 3.9.7, vitest 4.1.11/5.0.1 and the
new `cacheable`/`file-entry-cache`/`flat-cache` tree), with no changes to
runtime dependencies.
