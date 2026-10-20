# Separate branch-cumulative and uncommitted All Changes diffs

Status: implemented
Translation: current

[中文](2026-10-19-all-changes-diff-scope.zh.md)

## Abstract

All Changes compared `merge-base(base, HEAD)` with disk, so committed branch work stayed in the diff and the base was never named. The workspace diff now accepts `branch` (unchanged default) and `uncommitted` (`HEAD` vs disk, including staged, unstaged and untracked non-ignored files) scopes, shows the resolved base, and defaults to `branch`. The Changes sidebar list remains branch-cumulative.

## Decisions

- Scope travels with both the batch and deferred single-file requests; deferred reads stay live and may see a newer `HEAD`, and uncommitted never falls back to turn-evidence snapshots.
- Non-Git and unborn worktrees return explicit `not_a_git_worktree` / `no_commits`; the old silent `HEAD` substitution returned untracked-only.
- `codeCollabAllChangesScope` protocol capability 1 gates the control; older daemons keep receiving branch requests without the field.
- Uncommitted mode renders the batch's own file set and explains a focused file outside it. The Changes list stays branch-cumulative because other surfaces consume that published state.

## Verification

Real-Git service tests cover branch/committed/staged/unstaged/untracked/deleted, post-commit clearing, non-Git and unborn worktrees, deferred scope, and `not_changed`. The full CLI suite, affected component suites and package typechecks pass; Storybook states were exercised in a browser. The Changes sidebar list is unchanged, and oversized entries remain deferred under the existing response budget.
