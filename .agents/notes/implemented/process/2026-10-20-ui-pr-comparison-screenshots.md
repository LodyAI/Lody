# Recommend before and after screenshots for UI pull requests

Status: implemented
Translation: current
PR: [#1744](https://github.com/LodyAI/Lody/pull/1744)

[中文](2026-10-20-ui-pr-comparison-screenshots.zh.md)

## Abstract

UI pull requests can describe a visible change without showing the result,
leaving reviewers to reproduce both versions. The PR template now recommends
labeled before/after screenshots, and the visual guide explains how Agents can
capture them during implementation using synthetic data. Privacy takes priority:
authors inspect the exported images before sharing and explain when a safe pair
is unavailable. This guidance adds no screenshot requirement or automated gate.

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
private content before either a public upload or a commit. Captured user/agent
transcripts remain prohibited. Reviewers receive accessible safe artifacts, not
local-only paths.

Requiring a pair would pressure authors to expose private content or manufacture
a missing baseline. Instead, authors describe capture limitations and provide
the safe evidence available. Existing required template headings and the
structural-view validator remain unchanged.

## Verification

The change is documentation only. All 23 existing PR-template and policy tests
passed, including complete and rejected bodies. `pnpm format` and the full
`pnpm check` passed. Documentation checking retains only the six existing missing
Kimi/Pi submodule links in the bilingual subagent-events note, with no new errors
or SHA-protected topic changes. No UI rendering change is claimed.
