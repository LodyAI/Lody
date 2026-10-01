# Distinguish session scope emptiness from search misses

Status: implemented
Translation: current

[中文版](2026-10-01-session-mention-search-empty-state.zh.md)

## Abstract

The Sessions mention menu claimed that a populated project scope had no other
sessions whenever a search matched nothing. The composer now supplies the
scope-empty message only when its project-filtered candidate list is empty,
allowing the menu's existing localized query-miss message to appear otherwise.
Project isolation, query retention, focus, and clearing the query keep their
existing behavior. Regression tests reproduce the defect with synthetic data;
the packaged desktop and live workspace remain unverified.

## Decision and evidence

At main `7d502f3d99fdcdbbdd43d032c6d903d4ed497e04`, the composer supplied
`session.emptyState` whenever scope was `current`. The menu renders a supplied
empty state before its query-miss fallback, so no matching rows incorrectly
implied no underlying sessions. Three composer tests failed before the fix,
including a No project draft with 14 candidates.

Main `93545f01b69cb0c98ddd3f19d46540decd95a007` still contains that condition;
the later main update does not cover this fix.

Gate that source-owned empty state on `visibleSessionItems.length === 0` as
well as current scope. The list is already filtered by project before query
ranking. A real empty scope retains its explanatory message and "View all
projects" action, including while a query is present. A populated scope with
no matches uses "Nothing matches “query”"; the header still permits widening
the scope. This preserves the
[existing no-match decision](../feature/2026-09-25-composer-mention-menu-v2.md#design-review-round-2).

Prioritizing every nonempty query over category empty states would also hide
the useful explanation for a genuinely empty project. No generic menu contract,
session addressing rule, or trigger policy changes are needed.

## Verification

The existing composer activation suite covers No project, GitHub, and local
scopes with 14 synthetic candidates each: an absent term, a term found only in
another project, clearing both queries, All projects search and clearing,
switching back, and retained input focus and query. Actual empty No project
and current-project scopes retain the widening action. Existing coverage also
checks scope reset after closing and reopening the menu.

The targeted composer, registry, menu, and session insertion run passed
93 tests in four files; the session-source and item suites passed another
30 tests in two files. A Playwright Chromium test also passes against the real
landing composer and catalog pipeline in a local Storybook fixture seeded with
14 No project session metadata records and one other-project record. It checks
both query misses, clearing back to 14 candidates, widening with query/focus
retained, and clearing All projects back to 15 candidates. Non-loopback requests
are blocked in a fresh browser context.

The [before/after capture](2026-10-01-session-mention-search-empty-state.png)
uses the same synthetic data and 1440 × 900 viewport. Both capture runs passed
their phase-specific assertions. The before run temporarily restored the original
composer source (Git blob `8a3e82c2e8423dca7cc7a1f16cf995bfcc06335a`, identical
to the baseline source); the after run restored the committed fix. The comparison
uses identical crops of the original screenshots, without changing their content.
Run the browser regression with
`pnpm --filter @lody/components exec playwright test --grep 'No project session searches'`.
Native Electron rendering, mobile layout, and real workspace catalog loading
remain unverified. No captured user sessions are test fixtures.

Root `pnpm check` passed typechecking and lint but failed at the unchanged
boot-shell storage-unavailable test: components had 4,594 passing tests and
one failure. That 19-test boot-shell suite also fails standalone under Node
26.10.0, with its test, implementation, setup, and configuration unchanged from
main. No boot-shell fix is included. Separately running the remaining Electron
tests passed 199 tests; i18n and all three import/platform/public boundary guards
passed. Formatting and the documentation check passed; existing documentation
warnings remain.

## Owners

- [Draft PR #1189](https://github.com/LodyAI/Lody/pull/1189)
- [Composer source](../../../../packages/components/src/components/mentions/combined-mention-textarea.tsx)
- [Regression suite](../../../../packages/components/tests/combined-mention-textarea-activation.test.tsx)
- [Browser regression](../../../../packages/components/tests/e2e/composer-mention-placement.spec.ts)
- [Synthetic local scene](../../../../packages/components/src/stories/SessionMentionSearch.stories.tsx)
- [Session pipeline explanation](../../../docs/ui-mentions.md#sessions)
