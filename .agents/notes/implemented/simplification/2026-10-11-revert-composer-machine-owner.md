# Revert composer machine identity

Status: implemented
Translation: current

[中文](2026-10-11-revert-composer-machine-owner.zh.md)

## Abstract

The user requested removing the machine name and owner from the composer info bar.
The display introduced by #1300 is reverted, restoring the original single-row
cluster/stage layout on desktop and mobile. Identity-only props, styling, stories,
tests and translation keys are removed. The bar no longer provides persistent
execution-machine ownership information.

## Decision and evidence

Reverse the relevant implementation hunks of commit `385f1a727`, preserving later
unrelated changes. Retain the original proposal as history and mark its
[Spec](../../../../specs/composer-machine-owner.md) outdated. This supersedes the
[identity proposal](../../proposed/feature/2026-10-07-composer-machine-owner.md).
The existing context-less/syncing cases remain in the owning info-bar suite.

The focused Vitest suite could not run because this checkout has no installed
workspace dependencies (`vitest` is unavailable). Live UI verification remains
unperformed.

`git diff --check` passed. Root `pnpm check` and `pnpm format` were attempted
but could not finish without `tsgo` / `oxfmt`. Documentation checks report
existing links to missing ACP submodule files; no protected topics are registered.

PR: [#1431](https://github.com/LodyAI/Lody/pull/1431).
