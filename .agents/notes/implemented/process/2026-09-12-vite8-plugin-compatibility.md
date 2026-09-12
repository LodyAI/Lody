# Vite 8 plugin compatibility baseline

Status: implemented
Translation: pending
PR: https://github.com/LodyAI/Lody/pull/630

## Abstract

Several workspace build plugins declared peer ranges that stopped at Vite 7,
which prevented a supported Vite 8 migration even before exercising the new
Rolldown bundler. The React, WebAssembly, and standalone-file plugins are raised
to versions that support Vite 8 while retaining compatibility with the current
Vite 6 and 7 lanes. Keeping the bundler versions unchanged isolates plugin
behavior from the later compiler and bundler migration.

## Pressure

The shared catalog supplied `@vitejs/plugin-react` 4.x to the CLI-adjacent build
surfaces, while the desktop used 5.1 directly. Both peer ranges ended at Vite 7.
The workspace also used `vite-plugin-wasm` 3.5 and `vite-plugin-singlefile` 2.3.0,
whose published peer contracts did not include Vite 8.

## Decision

The catalog and desktop use `@vitejs/plugin-react` 5.2, the first common version
that accepts Vite 4 through 8. All public workspace consumers use
`vite-plugin-wasm` 3.6, and the review helper uses `vite-plugin-singlefile` 2.3.3.
This layer deliberately retains the existing Vite versions so regressions in the
plugin upgrades remain distinguishable from Rolldown migration failures.

Storybook and its Vite integration remain unchanged here. They are migrated in a
separate layer because Storybook 10 also changes its configuration module format.
The Electron application likewise stays on Vite 7 until a stable electron-vite
release supports Vite 8.

## Verification

The lockfile is resolved from a standalone clone because managed nested worktrees
must not install a second pnpm virtual store. Package peer ranges, the CLI bundle,
component build, review-helper standalone output, and desktop development build
are the relevant compatibility boundaries. The later Vite 8 layer repeats the
artifact checks against Rolldown.
