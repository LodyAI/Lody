# Keep direct local project sessions on one sidebar line

Status: implemented
Translation: current

[中文](2026-10-18-local-repo-session-row-height.zh.md)

## Abstract

Desktop local-project rows showed a branch/time line for every top-level session, even when a session ran directly in the project folder and only carried GitHub repository metadata. That made repo-linked direct sessions look like worktree sessions and added a second line the user did not ask to see. The row now shows branch and time beneath the title only for local worktree sessions; direct sessions keep their repo and PR affordances while remaining one line. The first child's tree connector extends past the opener's metadata only when that opener actually has the worktree line.

## Finding and decision

`LocalProjectSessionItem` used `isWorktree` for the worktree glyph, but its two-line row condition only checked that the session was not a nested child. `session.project.githubRepoFullName` can associate a direct local session with a GitHub repo without creating a worktree, so repository metadata is not evidence that the row needs branch/time space.

Gate the local-project metadata line on `session.isWorktree === true`. Keep repo and PR details available through their existing row affordances and hover card. When an opener has no metadata line, its first child's connector uses the one-line row geometry; the existing tall connection remains for worktree openers. Add a synthetic repo-linked direct session to the full workspace Story so this distinction can be selected alongside plain local and worktree sessions.

## Verification

Oxfmt, `git diff --check`, a component typecheck, and a browser render of the new repo-linked Story state were used to check the change. The component typecheck reports two existing errors outside this change in `loro-sidebar.tsx` and `home-week-usage.ts`; the Story renders without browser page errors. No automated test was added or run.

Related: [sidebar session tree](../../../docs/components-sidebar-session-tree.md).
