# Align public session search documentation

Status: implemented
Translation: current

[中文](2026-10-01-session-search-public-scope.zh.md)

## Abstract

The public Introduction promised search across tool calls, terminal output, and
diffs, while the current index and detailed guide deliberately support conversation
text only. The Introduction now matches that scope, and both language guides
distinguish conversation search from session navigation in the command palette.
A regression verifies that paths and code written in prose remain searchable without
matching identical tool payloads. Search behavior and indexing scope are unchanged.

## Correction and evidence

At main `7d502f3d99fdcdbbdd43d032c6d903d4ed497e04`, the
[extractor](../../../../packages/components/src/lib/session-chat-search.ts)
accepts only `text`, `thought`, and `proposed_plan` items. The
[incremental reader](../../../../packages/components/src/hooks/use-incremental-search-blocks.ts)
uses that same extractor. Tool payloads, structured plan checklists, goals, and
worktree script output are deliberately excluded; this is stale Introduction copy,
not an unimplemented requirement. Expanding the index would change the established
noise-filtering decision and is outside this correction. No Spec intent changes.

The [detailed guide](../../../../site-docs/content/docs/en/%28features%29/session-search.mdx)
owns the scope and exclusions. Paths and code in message or proposed-plan text are
searchable; excluding tool file-path fields does not exclude textual path references.
The [command palette](../../../../packages/components/src/components/commands/command-palette.tsx)
instead matches session titles, project/repository labels, and branch names. The
[sidebar search decision](../feature/2026-09-11-sidebar-search.md) remains intact.
PR [#1063](https://github.com/LodyAI/Lody/pull/1063) fixes highlight DOM ownership,
not the public scope discrepancy; its [note](2026-09-27-search-marks-keep-react-text.md)
remains relevant.

## Verification and limits

The owning [search suite](../../../../packages/components/tests/session-chat-search.test.ts)
passes all six tests with Vitest 3.2.4 and a temporary Node-only configuration.
The new mixed-history regression checks both extraction entry points, result identities,
match offsets, and zero results for a tool-only marker; JSON input is also covered
by the existing tool exclusion test. No production code changes are needed.

The worktree has no installed dependencies. `pnpm check` stops at missing `tsgo`,
and `pnpm format` stops at missing `oxfmt`. Repository docs status already reports
62 broken links to absent ACP submodule files and no registered SHA topics;
`pnpm run docs check` reports those same existing errors. Targeted Oxfmt 0.65.0
format checking passes for all eight changed files, as does `git diff --check`.
Full application type/build checks, deployed documentation, and production UI
interactions are not verified by the focused regression.
