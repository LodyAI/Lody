# Vite 8 frontend migration

Status: implemented
Translation: pending
PR: https://github.com/LodyAI/Lody/pull/633

## Abstract

The components package and standalone review helper now target Vite 8.3. The CLI
remains explicitly on Vite 7 because its bundled logging dependency is not
compatible with Rolldown's CommonJS interop, while the desktop remains on Vite 7
because electron-vite 5 does not declare Vite 8 support. This boundary adopts
Rolldown only where the complete build and runtime paths pass without local
dependency patches or peer exceptions. Vite 7 also satisfies the current
TanStack Start peer contract used by the CLI.

## Pressure

Vite 8 replaces Rollup and esbuild-based internals with Rolldown and Oxc. The
repository has custom plugins, worker bundles, SSR entries, and a single-file
build, and the CLI bundles older CommonJS dependencies into its published
artifact. Upgrading every surface together would turn unrelated compatibility
gaps into local patches and obscure which build path caused a regression.

## Decision

Raise the shared catalog to Vite 8.3 after the compatible plugin and Storybook
layers, then pin both the CLI and desktop to stable Vite 7. Verify components
library and Storybook builds plus
review-helper standalone and Storybook builds under Rolldown. Raise the CLI's
directly used esbuild to 0.28 as an independent development-builder upgrade.

Move the components name-preservation option from esbuild to Oxc and make local
config imports explicit for the native loader. Retain `vite-tsconfig-paths`, but
point it at `tsconfig.vite.json`: the typecheck config has type-only React
mappings that both the native resolver and the plugin would incorrectly apply to
Rolldown's runtime Storybook graph. Keep shared alias helpers structurally typed
so their Vite 8 implementation types do not leak into the Vite 7 CLI and desktop
configs.

The first macOS ARM CI run exposed an incomplete lockfile snapshot: the
`rolldown@1.2.8` JavaScript wrapper had no matching optional native dependencies,
so pnpm could only install the older 1.1.5 bindings retained elsewhere in the
graph. The resulting hook-bit mismatch caused Rolldown to panic before module
transforms began. Regenerate the lockfile with pnpm 10.20.0's fix-lockfile path so
every supported 1.2.8 native binding is recorded alongside the wrapper. Treat
wrapper/native version equality as an installation invariant for future Rolldown
updates.

A macOS ARM desktop smoke demonstrated why the CLI cannot join this migration.
`file-stream-rotator@0.6.1`, pulled by the current
`winston-daily-rotate-file`, invokes the result of `require('moment')` as a
function. Rolldown's consistent interop produces a namespace-shaped value, so the
embedded CLI exits during file logger initialization. Vite's legacy bridge does
not cover that nested `require()` shape. Do not patch the transitive dependency;
keep the CLI on Vite 7 until the logging dependency removes the ambiguous contract
or the transport is deliberately replaced.

## Validation

- A frozen pnpm 10.20.0 install in a clean macOS ARM clone installed both
  `rolldown` and `@rolldown/binding-darwin-arm64` at 1.2.8.
- The previously failing review-helper standalone build transformed 2,334 modules
  and produced the complete single-file artifact under Vite 8.3.0.
- Components library and Storybook builds and both review-helper build modes pass
  under Vite 8.3.0.
- The CLI development builder passes with esbuild 0.28 while its published bundle
  remains on Vite 7.
