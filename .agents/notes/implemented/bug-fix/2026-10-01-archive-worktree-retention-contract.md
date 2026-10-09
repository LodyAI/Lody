# Align archive documentation with managed-worktree retention

Status: implemented
Translation: current

[中文](2026-10-01-archive-worktree-retention-contract.zh.md)

PR: [#1195](https://github.com/LodyAI/Lody/pull/1195).

## Abstract

The GitHub guide promised to retain worktree directories until permanent Session deletion,
while the existing lifecycle contract and daemon reclaim them after archive. Session and workflow
guides also overstated backup protection and storage reclaimed by deletion. The documentation and
auto-archive settings now distinguish conversation history, managed directories, local branches,
non-ignored backup commits, and ignored files. Cleanup behavior is unchanged; this corrects a
public contract mismatch and does not establish an incident involving real user data loss.

## Evidence and decision

The implementation baseline was `93545f01b69cb0c98ddd3f19d46540decd95a007`; the archive implementation
and conflicting copy were unchanged from the initial `7d502f3d99fdcdbbdd43d032c6d903d4ed497e04`.
The shorter notice also checked main `c687e45ae6a59e27b5cc7431889c08b3231e9446`,
which still had the old notice without retention limits.
Searches of existing PRs
found the lifecycle implementation in [#620](https://github.com/LodyAI/Lody/pull/620) and
the Preferences reorganization in [#987](https://github.com/LodyAI/Lody/pull/987), but no effective
fix for the conflicting retention copy. The earlier
[reconciliation decision](../architecture/2026-09-11-session-worktree-reconciliation.md)
remains the runtime design. [#1191](https://github.com/LodyAI/Lody/pull/1191) separately names
Preferences switches and does not fix retention documentation.

- [Worktrees](../../../../site-docs/content/docs/en/%28core-concepts%29/worktrees.mdx) owns the public
  resource table, cleanup timing, backup scope, and restore requirements. GitHub, Sessions, and
  Workflow link to that explanation while preserving their local usage instructions.
- The [lifecycle Spec](../../../../specs/session-worktree-lifecycle.md) remains draft and now
  explicitly requires the same retention disclosure for manual and automatic archive.
- Desktop and mobile auto-archive settings explain the boundary before users enable a rule.
  The rule is device-local; the archived state can reclaim a worktree on its owning machine.
  The notice leads with retained chats and branches, possible directory cleanup, and files
  that may be lost; technical backup details stay in Worktrees rather than crowding the hint.
- The configured cleanup script runs before `archiveWorktree` stages and commits. Consequently,
  its deleted or modified files are outside the backup guarantee. Backup failure retains the
  directory for retry, whereas script failure does not prevent cleanup.
- Permanent Session deletion does not delete the local branch or backup commits. Manual removal
  of repository data would erase those recovery resources and is not a substitute for archive.

Changing cleanup to retain directories until deletion would contradict the existing design and
change disk usage and recovery behavior. This change instead corrects the stale promise and
adds a visible disclosure. The local-project removal dialog's separate immediate-cleanup wording
remains outside this change, as already recorded by the lifecycle Spec.

## Verification and limits

The owning [GC suite](../../../../apps/cli/tests/worktree-gc.test.ts) uses temporary real Git
repositories with isolated data and lock roots. It covers local and bare-repository archive,
tracked modifications and deletions, untracked backup, ignored-file omission, branch survival after
a deleted-owner sweep, restore, backup failure, and a cleanup script that mutates files then fails.
The [auto-archive suite](../../../../packages/components/tests/auto-archive-pr.test.ts) exercises
the rendered English and Chinese notice and independent rule toggles alongside PR transitions.
Playwright also checks the real section against the main baseline in a local, signed-out fixture:
the same 1280×720 viewport, Chinese locale, and disabled rules, with no external requests.
It verifies independent toggles and local persistence; inspected before/after screenshots are
uploaded to the requesting Lody conversation, not treated as evidence of file cleanup.

The final GC suite passed 12 tests; the existing create/remove suites passed 41 tests, and
auto-archive/settings navigation passed 19 tests. `pnpm format`, site content generation,
documentation checks, i18n, and import/platform/public boundary checks passed. Full `pnpm check`
stopped at ACP adapter compilation. Direct CLI/components typechecks also failed on missing or
incompatible dependencies in the reused local dependency tree; no errors named the changed files.
Root lint stopped on a missing Node type definition. These failures are verification limits,
not claimed passes or fixes to unrelated modules.

No real Session was archived or deleted. Live desktop/mobile behavior across a reconnect,
long-term deletion-marker compaction, remote backup durability, and files removed by user scripts
are not established by these fixtures. The Spec remains subject to human review.
