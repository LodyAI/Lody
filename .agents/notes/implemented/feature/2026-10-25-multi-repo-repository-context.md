# Multi-repository Info Bar selects one repository's GitHub context

Status: implemented
Translation: current

[中文](2026-10-25-multi-repo-repository-context.zh.md)

## Abstract

A Project group conversation showed its repositories as a flat list while the
Info Bar context stage, PR tab and live GitHub actions always described the
first Member. That made several current PRs feel like "the last one loaded" and
gave no way to inspect another repository without leaving the conversation. The
Repositories panel now renders the frozen placement forest (submodules nested
under their parents) and each row selects a repository; the context stage, diff
stat, PR tab and existing-PR actions then describe that Member. Selection is
view state, defaults to the legacy first-Member projection, and never borrows
another Member's PR for a local folder without a GitHub remote. Verified with
unit and jsdom tests and Storybook; not exercised end to end in the packaged
desktop app.

## Decision

- `buildSessionProjectMemberRows` emits rows in pre-order: roots in snapshot
  order, each followed by its submodules, with `depth`, `parentId` and
  `hasChildren`. The panel indents by depth instead of inventing a second tree
  model; the frozen snapshot remains the source of truth.
- `sessionProjectMemberSelectionAtomFamily` holds the selected Member id, keyed
  by the workspace-owner Session so a child tab and its root describe the same
  repository. It is not persisted, like the Info Bar's staged item.
- With no selection, the legacy `project` / `repoFullName` projection is the
  fallback. Once selected, the stage uses that Member's repository, branch,
  path, diff and current PR; `null` is a meaningful explicit value for "this
  Member has no GitHub remote", distinct from "use the legacy default".
- The PR tab, `useGitHubPrDetails`, Fix CI Errors, Resolve Conflicts, Ready for
  review and Merge follow the selected PR. Create PR and Commit & Push stay
  conversation-scoped because their prompt publishes every changed Member.
- CI is the PR glyph's tone, not a second dot: the glyph shape keeps the PR
  status (open / draft / merged / closed), while green / red / amber reads the
  CI verdict. Unreported CI leaves the PR-status color.
- A Member used in place (`additional` / `link`) keeps the folder glyph and
  clears GitHub identity rather than pretending its mount path is a copyable
  host path.
- Rejected: a separate "all pull requests" view. The Repositories panel already
  carries every Member and its current PR/CI, so a second list would duplicate
  the source and split the selection between two surfaces.

## Evidence

- `packages/components/tests/session-project-members.test.ts` covers nested
  ordering, depth/parent fields, and the selection/legacy fallback.
- `packages/components/tests/session-project-members-chip.test.tsx` covers
  indentation, labels, selection, panel dismissal, CI tinting the PR glyph
  without a separate dot, and PR buttons selecting their repository before
  opening.
- `packages/components/tests/session-github-state.test.ts` covers selecting a
  Member's PR and explicitly clearing the repository for a Member without a
  remote.
- `SessionProjectMembersChip.stories.tsx` renders the nested list and selected
  state on the real Info Bar.

## Verification and limits

Typecheck and the tests above pass. The panel has not been driven against a real
multi-repository daemon: submodule depth beyond the synthetic fixture, live CI
and merge behavior on a non-default Member, and mobile popover sizing remain
unverified end to end.
