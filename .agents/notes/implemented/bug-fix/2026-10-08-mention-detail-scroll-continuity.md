# Preserve mention-list scroll when previewing Agent Roles

Status: implemented
Translation: current
PR: [#1317](https://github.com/LodyAI/Lody/pull/1317)

[中文版](2026-10-08-mention-detail-scroll-continuity.zh.md)

## Abstract

An aggregate `@` search could jump to the top when the pointer reached an
Agent Role, making the intended row difficult to select. Showing or hiding
the candidate's detail pane replaced the list's ancestors and remounted its
scroller and registered rows. The menu now keeps those ancestors mounted and
changes only the pane and layout styles. Synthetic Chromium reproduction and
behavioral tests confirm preserved scrolling and successful Role selection;
the packaged desktop application remains unverified.

## Decision and evidence

`MentionTwoLevelMenuBody` always retains the same list wrappers. Detail layout
styles apply only while a pane exists, preserving the intrinsic width of a
menu without details. This extends the
[mention menu surface decision](../feature/2026-09-25-composer-mention-menu-v2.md)
without changing candidate ranking, availability, insertion, or dispatch.

Saving and restoring `scrollTop` would mask the remount while still replacing
the registered rows under the pointer. Stable ancestors preserve both.

The `MainComposerAggregateRoles` story uses synthetic Files, Issues, PRs, and
Roles in the real floating menu. In Chromium, hovering its Role reset the old
list from `scrollTop = 152` to `0` and replaced the row. With the fix, the
list and row remain the same, the scroll stays at `152`, and clicking inserts
`@Code-Reviewer`. Unit coverage exercises entering, leaving, and re-entering
the preview before mouse or Enter selection. The existing reverse-navigation
test advances a fake animation frame before asserting its initial highlight.

Playwright video acceptance repeats the same search, scroll, pointer movement,
and click coordinates against the old and fixed implementations. The old menu
resets to `0` and the click inserts `#101`; the fixed menu retains `152` and
inserts `@Code-Reviewer`. Both recordings use the synthetic story catalog and
include step captions and a pointer marker. The recording restores the fixed
source even if acceptance fails; generated videos stay outside committed files.

## Verification limits

All 134 tests in six focused mention suites pass, as do source lint/format checks.
Component type checking is blocked by missing or mismatched dependencies in
the reused local installation, including document viewers and Loro APIs.
`docs check` reports existing broken links into uninitialized ACP submodules;
it reports no broken links for the changed documents.
No packaged Electron or physical mobile acceptance was performed. The current
[pipeline explanation](../../../docs/ui-mentions.md) owns implementation context;
the [Role mention Spec](../../../../specs/agent-role-mentions.md) retains its intent.
