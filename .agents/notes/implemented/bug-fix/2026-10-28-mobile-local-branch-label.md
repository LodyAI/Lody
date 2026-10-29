# Readable branch labels in mobile new chat

Status: implemented
Translation: current
PR: [#1997](https://github.com/LodyAI/Lody/pull/1997)

[中文](2026-10-28-mobile-local-branch-label.zh.md)

## Abstract

Mobile new chat displayed an opaque local branch selector such as
`lody:branch:local:main` when worktree was off. That path read the checked-out ref
directly, bypassing the existing label formatter. A shared display resolver now
selects the relevant ref and formats it for both direct local use and worktrees,
while preserving the exact selector used for launch. GitHub names remain verbatim.

## Decision and evidence

This corrects the branch row introduced by the
[mobile new-chat page](../feature/2026-10-28-mobile-new-chat-page.md).
Direct local use displays the directory's checked-out branch; enabling worktree
displays the user's selected base branch. Both use `getLocalProjectBranchLabel`,
including decoded names and localized local/remote suffixes. Missing refs use the
existing placeholder. The read-only direct-local control remains read-only.

The real-component story previously used plain `main` values, hiding the bug.
It now supplies encoded local selectors and shares the production resolver.
Unit coverage includes checked-out versus selected refs, remote refs, legacy
plain names, missing data and GitHub names resembling selectors. The browser
case switches to another worktree base, disables worktree to show the checked-out
branch, and re-enables it to confirm the choice survives. Existing light/dark
artboard captures are refreshed rather than keeping obsolete examples.

## Verification limits

Nineteen unit tests, five Chromium cases and a WebKit worktree-toggle check pass,
along with component typecheck, type-aware lint, formatting and i18n validation.
Ryugi reports no layout warnings. Root checks remain limited by uninitialized ACP
extensions and their missing documentation links. iOS Debug `0.107.2 (20261028.7)`
builds, passes strict signature validation and is installed on the physical phone.
Installation verifies delivery, not device interaction acceptance. The isolated
phone build keeps the earlier native/cloud dependency baseline and applies this
scoped product patch; it is not a full latest-main integration build.
