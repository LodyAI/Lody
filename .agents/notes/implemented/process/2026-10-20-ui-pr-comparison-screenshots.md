# Recommend before and after screenshots for UI pull requests

Status: implemented
Translation: current
PR: [#1744](https://github.com/LodyAI/Lody/pull/1744), [#1747](https://github.com/LodyAI/Lody/pull/1747)

[中文](2026-10-20-ui-pr-comparison-screenshots.zh.md)

## Abstract

UI pull requests can describe a visible change without showing the result,
leaving reviewers to reproduce both versions. The PR template now recommends
labeled before/after screenshots, and the visual guide explains how Agents can
capture them during implementation using synthetic data. Privacy takes priority:
authors inspect the exported images before sharing, then upload review captures
as GitHub attachments instead of committing them. Screenshots are optional
and may be omitted without explanation; this guidance adds no automated gate.

## Decision

The existing [visual explanation decision](2026-09-08-required-pr-visual-explanations.md)
requires a structural view for complex changes. Screenshot comparison answers a
different question: what a reviewer will see before and after a UI change. The
recommendation lives in the PR template's existing Before / after section, which
Agents already read through the GitHub contribution instructions. The
[visual guide](../../../docs/visual-explanations.md#ui-screenshots) owns practical
capture, privacy, and presentation advice. No new instruction is added to the
nearly full root or GitHub `AGENTS.md` files.

The comparison uses real UI or owning Storybook fixtures with comparable state,
viewport, and theme. Synthetic data and an isolated development scene reduce
exposure before capture; inspection of the final crop or redacted export catches
private content before a public upload. Captured user/agent
transcripts remain prohibited. Reviewers receive accessible safe artifacts, not
local-only paths.

The attachment clarification keeps PR-only captures in temporary or ignored paths,
out of Git history. GitHub CLI supports `gh pr create --attach` and
`gh pr edit --attach`; matching local Markdown image references in the complete body file are rewritten
to uploaded attachment URLs. The guide includes a command for a before/after pair.

Authors decide whether to include screenshots and may omit them without
explanation. Existing required template headings and the structural-view
validator remain unchanged.

## Verification

The attachment clarification is documentation only. All 23 existing PR-template
and policy tests pass. Installed `gh pr create --help` and `gh pr edit --help`
confirm attachment uploads and local image-reference rewriting. `pnpm format`
passes. Documentation checking retains the six existing missing Kimi/Pi submodule
links, with no new errors or protected-topic changes. Full type/build/runtime
checks were not rerun for this documentation-only clarification. Template headings,
validators and runtime code remain unchanged.
