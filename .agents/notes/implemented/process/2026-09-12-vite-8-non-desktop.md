# Vite 8 non-desktop migration

Status: implemented
Translation: pending
PR: https://github.com/LodyAI/Lody/pull/633

## Abstract

The shared Vite catalog used by the CLI, components package, and standalone
review helper now targets Vite 8.3. The desktop build remains on its explicit
Vite 7 dependency because electron-vite 5 does not declare Vite 8 support. This
boundary moves the independently buildable surfaces to Rolldown without
conflating that migration with the Electron runtime upgrade.

## Pressure

Vite 8 replaces Rollup and esbuild-based internals with Rolldown and Oxc, while
the repository has several custom plugins, worker bundles, SSR entries, and a
single-file build. Upgrading every surface together would make electron-vite's
unsupported peer contract a hard blocker and obscure which custom build path
caused any regression.

## Decision

Raise only the shared catalog to Vite 8.3 after the compatible plugin and
Storybook layers. Verify the CLI SSR multi-entry output, components library and
Storybook builds, and review-helper standalone and Storybook builds under the
new bundler. Raise the CLI's directly used esbuild to 0.28 so its development
builder also satisfies Vite 8's optional peer contract. Move the components
name-preservation option from esbuild to Oxc and make local config imports
explicit for the future native loader. Retain `vite-tsconfig-paths`, but point it
at `tsconfig.vite.json`: the typecheck config has type-only React mappings that
both the native resolver and the plugin would incorrectly apply to Rolldown's
runtime Storybook graph. Keep shared alias helpers structurally typed so their
Vite 8 implementation types do not leak into the Electron Vite 7 config. Keep
`apps/electron` on Vite 7 until electron-vite publishes a stable release whose
peer contract includes Vite 8.
