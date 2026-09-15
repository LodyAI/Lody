# Adopt Oxfmt for package formatting

Status: implemented
Translation: current

PR: [#737](https://github.com/LodyAI/Lody/pull/737)

[中文](2026-09-15-adopt-oxfmt.zh.md)

## Abstract

Package formatting previously used Prettier, while route generation could produce
format-only differences from the committed route tree. This change adapts hyoban's
[community PR #330](https://github.com/LodyAI/Lody/pull/330) to current main and uses
Oxfmt for the existing package formatting commands and generated component routes.
ACP submodules retain independent tooling; this is not a full-repository formatting
sweep or a release-artifact recovery.

## Decision and boundaries

The root Oxfmt configuration preserves the previous general style and Electron's
semicolon-free override. CLI, Electron, and cloud-api formatting commands use it.
Components run `tsr generate && oxfmt src/routeTree.gen.ts` and declare Oxfmt directly
so the command does not depend on installation of the public root package when
embedded in a parent workspace. CLI, Electron, and cloud-api likewise declare
Oxfmt locally instead of depending on an absent parent binary. That parent must refresh its dependency lockfile
when adopting this revision.

A Prettier-only route normalization fix was possible, but would retain a second
formatter after adopting the community change. Electron's Prettier dependency is
retained for its existing ESLint compatibility config, not for its format command.
The toolkit enables `prettier/prettier` by default; explicitly disable that rule so
editor ESLint fixes cannot reformat Oxfmt output with a second formatter.
Source reformatting is mechanical; runtime behavior and ACP submodule pointers are
unchanged. The original community commits remain in the branch history.

## Verification

The existing recursive Oxfmt checks pass for CLI, Electron, and cloud-api. Two route
generation runs produce the same SHA-256 and no change from the committed route tree.
Final workspace typecheck, quick checks, and all 118 Electron tests pass. The full
`pnpm check` passed 3,690 component tests and 2,835 CLI tests, but exited nonzero on
five gh-shim tests: an unrelated temporary-directory package marked generated
CommonJS shims as ESM. All seven tests in that unchanged file pass with an isolated
CommonJS temporary directory. The latest main integration's 82 focused draft tests
also pass. This is combined verification, not a clean full-command exit.
The public frozen lockfile validates; a real parent-workspace installation resolves
Oxfmt 0.65.0 in all four consuming packages. Independent reviews found no remaining
P0/P1 after fixing local dependency ownership and disabling the Prettier ESLint rule.
Publication and packaged-artifact inspection were not tested. This change alone does not publish or repair
already-created release artifacts.
