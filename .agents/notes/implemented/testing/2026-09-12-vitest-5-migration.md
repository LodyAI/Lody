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
