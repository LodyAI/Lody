# Regenerating the lockfile after a submodule pointer bump

Status: implemented
Translation: current
PR: [#2191](https://github.com/LodyAI/Lody/pull/2191)

[中文](2026-09-21-submodule-pointer-lockfile-regeneration.zh.md)

## Abstract

CI recursively checks out submodules before frozen installation. Workspace
adapter manifests therefore participate in the root lockfile, and a pointer bump
without matching resolutions blocks unrelated checks before tests start. Keep
the lockfile aligned with those manifests and admit only the exact selected
versions still inside the seven-day release window. Platform packages must remain
complete across hosts; later releases remain quarantined.

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
- pnpm 10.20 uses the first matching exception for each package. Extend that
  existing exact-version rule, including every optional platform package, rather
  than adding a later rule that pnpm ignores. The
  [Codex repair](../bug-fix/2026-10-27-codex-root-lockfile.md) records the same constraint.

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
(2026-09-20) moved `packages/acp-extension-claude` to `56b94c6c`; the pointer was
identical on `main` at that failure, so the mismatch predated the affected branch.

Seven of the ten versions were already older than seven days. Three roots and
the `@vitest/*` release train were not, and are the only additions to
`minimumReleaseAgeExclude`:

- `@anthropic-ai/sdk@0.126.0`
- `prettier@3.9.7`
- `vitest@5.0.1` and its `@vitest/{expect,mocker,pretty-format,runner,snapshot,spy,utils}@5.0.1`

`@agentclientprotocol/sdk@1.4.0` was initially added and then removed again
once its publish date was checked — it is well past the window and must keep
resolving under the normal policy.

The [November 1 PR merge check](https://github.com/LodyAI/Lody/actions/runs/41306898438/job/124849039169)
exposed the same boundary: the merged Claude submodule required Agent SDK
`0.3.316`, while the root importer still selected `0.3.293`. All test groups
stopped during dependency installation. The repair preserves other locked
resolutions and copies the selected SDK's complete eight-platform graph.

## Verification

Frozen installation verifies the recursively pinned manifests against the root
lockfile. Review the dependency-graph diff and optional platform entries before
formatting, type, static and behavioral checks. A local checkout that still holds
older submodule sources cannot establish that the merged version will install;
the pushed merge checks remain the integration boundary.
