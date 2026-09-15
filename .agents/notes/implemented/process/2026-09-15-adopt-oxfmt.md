# Adopt Oxfmt for package formatting

Status: implemented
Translation: current

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
Workspace typecheck and type-aware lint pass, as do all 112 Electron tests and the
documentation check. The full `pnpm check` was stopped during the component test
suite after typecheck, lint, and earlier tests passed; it is not a full-suite pass.
Publication was not tested. This change alone does not publish or repair
already-created release artifacts.
