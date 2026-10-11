# Chinese skill-menu trigger

Status: implemented
Translation: current

[中文](2026-10-02-yuan-skill-trigger.zh.md)

## Abstract

Chinese-input users could only open the direct Skills menu with `$`. The composer
now also registers `￥`, and the registry routes it to the existing Skills category.
Selection still inserts `$skill-name`; unselected text stays unchanged. This adds
an input convenience without introducing another stored skill syntax.

## Decision and evidence

Use a menu alias, following the [Chinese command-trigger decision](2026-09-24-chinese-command-trigger.md),
rather than rewriting composer text. Registration retains skill availability gates;
registry routing retains lazy activation and provider-filtered candidates. Existing
candidate insertion already supplies the canonical dollar prefix.
The [behavior draft](../../../../specs/skill-mention-triggers.md) records the intended behavior.

The existing composer suite covers both prefixes, inline opening, query filtering,
canonical keyboard selection, and cancellation without rewriting. Native Chinese
IME behavior requires manual verification; synthetic input events do not establish it.

## Verification

The focused composer, registry, and skill-source suites pass all 77 tests. Formatting,
document checks, full workspace typechecking and lint, i18n, and boundary guards pass.
`pnpm check` stops at the unchanged CLI `workspace-git-service.test.ts` remote-backfill
assertion (missing `githubRepoFullName`); that failure also reproduces in isolation.
The full test run therefore did not complete.

PR: [#1208](https://github.com/LodyAI/Lody/pull/1208).
