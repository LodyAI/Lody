# DSH completed process folding

Status: implemented
Translation: current
PR: [#1862](https://github.com/LodyAI/Lody/pull/1862)

[中文](2026-10-25-dsh-completed-process-folding.zh.md)

## Abstract

DSH showed each thought independently but had no way to collapse completed work
as a whole. It now uses the shared finished-work disclosure: streaming prose stays
visible, completion folds earlier work, and the final answer remains visible.
Expanding the process restores its ordered thought, prose and tool rows. Turns
without a visible answer retain the shared interruption safeguard.

## Decision and scope

This supersedes only the outer-fold exception in the
[independent display decision](2026-10-22-dsh-independent-text-tool-display.md).
Keep separate thought/tool groups and answer typography; remove DSH's opt-out from
the existing per-segment finished-work policy instead of adding a second disclosure
implementation. The final contiguous answer text run and result attachments follow
the shared layout contract. Search can open both the outer process and a nested
thought group. Duration returns to the shared desktop header/mobile footer policy.
Provider transport, stored history and other providers are unchanged.

The existing [thought visibility Spec](../../../../specs/deepseek-thought-visibility.md)
is updated to the requested behavior and remains draft, without claiming approval.

## Verification and limits

The three owning grouping/row suites pass 32 tests with an isolated AST-based
configuration that loads the actual row-builder and its transitive declarations,
excluding unrelated UI renderers. Coverage includes completion, whole-process
expansion/collapse, nested search reveal, independent toggles, provider cache
changes, interruption and existing plan segments. The DSH Storybook case now
checks collapse/expand/collapse and preserves its typography assertions.

The nested worktree has no installed dependencies. Root `pnpm check` and
`pnpm format` cannot complete because executables are missing. Borrowed dependencies
support isolated verification, not a full application build or executed Storybook
interaction test. No desktop visual validation is claimed.

The normal configuration passes 13 grouping tests; the two UI suites cannot load
`@pierre/highlights` and a missing export in the borrowed older UI package. Changed
code passes targeted lint with no errors and is formatted. Docs check retains
missing-submodule link errors; none concern this change.
