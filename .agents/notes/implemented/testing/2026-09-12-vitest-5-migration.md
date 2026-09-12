# Vitest 5 migration

Status: implemented
Translation: pending
PR: pending

## Abstract

All public workspace packages that directly depend on Vitest now use Vitest
5.0.0. The CLI coverage provider is aligned to the same exact version, and its
worker configuration uses the current top-level `execArgv` option.

## Pressure

The repository was pinned to Vitest 3.2.4 while other dependency families were
moving independently. Skipping Vitest 4 means the migration must account for the
removed per-pool configuration shape as well as Vitest 5's changed default mock
cleanup behavior. Vitest 5 supports the repository's existing Vite 6 and Vite 7
graphs, so coupling this change to Vite 8 would add unnecessary risk.

## Decision

Align every direct `vitest` dependency and `@vitest/coverage-v8` at 5.0.0. Move
the CLI's WASM flag from the removed `poolOptions` branches to `test.execArgv`.
Set `clearMocks: false` explicitly to preserve the existing Vitest 3 semantics;
future cleanup-policy changes should be deliberate and reviewed separately.
Allow Vitest 5 for better-auth 1.5.5's optional peer through pnpm's narrow
`allowedVersions` rule because the repository does not consume its test utilities;
upgrading better-auth instead would violate the current Convex adapter's `<1.7.0`
peer contract.

Vitest 5 no longer exposes an exact `vitest` Vite plugin name, which
`vite-plugin-wasm` uses to select its inline WASM transform. Add a test-only marker
with that name and alias the browser-only diff worker to a no-op worker in the Node
runner. Preserve the CLI's existing bare `src` resolution explicitly and make its
PostHog constructor mock constructible under Vitest 5.

## Validation

- Frozen pnpm 10.20.0 install completed under Node 22.23.2.
- CLI: 260 files and 2,695 tests passed; the same suite passed with V8 coverage.
- Components: 456 files and 3,466 tests passed.
- Shared, platform, ignore, supervisor, RPC, turn diff, and review helper suites
  passed (1,391 tests, with three RPC tests skipped by their existing contract).
- CLI and components typechecks passed after building their workspace prerequisites.
