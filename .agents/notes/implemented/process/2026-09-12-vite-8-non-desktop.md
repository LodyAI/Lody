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

The first macOS ARM CI run exposed an incomplete lockfile snapshot: the
`rolldown@1.2.8` JavaScript wrapper had no matching optional native dependencies,
so pnpm could only install the older 1.1.5 bindings retained elsewhere in the
graph. The resulting hook-bit mismatch caused Rolldown to panic before module
transforms began. Regenerate the lockfile with pnpm 10.20.0's fix-lockfile path so
every supported 1.2.8 native binding is recorded alongside the wrapper. Treat
wrapper/native version equality as an installation invariant for future Rolldown
updates.

The next macOS ARM desktop smoke exposed Vite 8's intentional CommonJS default
interop change in the embedded CLI. `file-stream-rotator@0.6.1`, pulled by the
current `winston-daily-rotate-file`, calls the result of `require('moment')` as a
function; Rolldown's consistent interop produced a namespace-shaped value and the
CLI exited during file logger initialization. Vite's documented legacy bridge is
insufficient because it does not cover this nested `require()` shape. Patch the
transitive dependency to accept either the callable CommonJS value or Rolldown's
`.default` value until the logging dependency removes that ambiguous contract. The
desktop artifact startup probe is the removal gate because importing the CLI with
`--version` does not initialize its file transport.

## Validation

- A frozen pnpm 10.20.0 install in a clean macOS ARM clone installed both
  `rolldown` and `@rolldown/binding-darwin-arm64` at 1.2.8.
- The previously failing review-helper standalone build transformed 2,334 modules
  and produced the complete single-file artifact under Vite 8.3.0.
- The patched Vite 8 CLI bundle initializes its hybrid file logger, then reaches
  the expected supervisor-contract rejection. The published-bundle check now
  runs that exact startup boundary without launching a daemon.
- The rebuilt macOS ARM desktop artifact passed all four P0 smoke scenarios and
  all 28 steps, including session startup, work creation, onboarding, and
  shortcuts.
