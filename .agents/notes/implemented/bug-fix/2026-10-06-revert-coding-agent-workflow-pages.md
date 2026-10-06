# Revert unintended coding-agent workflow pages

Status: implemented
Translation: current

[中文](2026-10-06-revert-coding-agent-workflow-pages.zh.md)

## Abstract

The requester confirmed with the author that commit `7700f420440288c1fa8c4f571f851a73b59ca767`
was included by mistake. Revert its GUI and remote-control marketing pages, discovery links,
and accompanying documentation changes. Preserve later anchor-navigation fixes and the original
decision record so the rollback remains traceable. Full build validation is unavailable in this
nested checkout without installed dependencies.

## Decision and scope

Revert [#1150](https://github.com/LodyAI/Lody/pull/1150), including route registration,
canonical URL handling, shared components and CSS, footer links, optional language switching,
and page-specific browser checks. The removed URLs follow the existing unknown-page 404 behavior;
no replacement redirect is introduced. This restores the intended site rather than changing
agent runtime or remote-access capabilities.

The [original note](../feature/2026-09-30-coding-agent-workflow-pages.md) is retained as history;
this decision supersedes its page-publication outcome. Resolve overlapping README and test edits
by retaining the later `anchors` browser phase and query/fragment navigation cases.

## Verification and limits

- Site unit tests pass after running the existing FAQ generator.
- The route/sitemap suite and whitespace validation pass.
- Root `pnpm check` and `pnpm format` were attempted but cannot complete without dependencies
  (`tsgo` and `oxfmt` are unavailable). Nested checkouts skip installation under repository policy.
- Documentation checking reports existing links into uninitialized ACP submodules; compare with
  the starting status to ensure this change adds no errors. No SHA-protected topics are registered.
- Production build and browser checks have not run in this checkout.
