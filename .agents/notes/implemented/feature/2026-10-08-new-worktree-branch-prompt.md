# Ask agents to name new worktree branches before their first task

Status: implemented
Translation: current
PR: [#1321](https://github.com/LodyAI/Lody/pull/1321)

[中文](2026-10-08-new-worktree-branch-prompt.zh.md)

## Abstract

Provider-owned titles removed Lody's isolated naming process, but the existing GitHub
prompt only asked for task-based branch names and did not explicitly request a rename.
Local worktrees received no such guidance. Ordinary new independent worktree Sessions
now ask their agent to inspect and rename the allocated temporary branch before starting
the first task. Existing Git observation publishes the result; execution remains model
guidance rather than an enforced rename, and Fork is outside this change.

## Decision

Separate provider-independent first-task worktree guidance from GitHub-specific prompt
context. Execution opts in only for an independent GitHub/local worktree Session with
neither a prior ACP session id nor an explicit resume request. This is a logical first-use
decision, so speculative worktree adoption receives the same request without filesystem
checks on the prompt path. Shared child Tabs, direct folders, subsequent turns, and the
separate Fork flow are excluded. No persisted flag or public protocol changes are needed.

The agent checks whether its current ref is still Lody's allocated `session/<id>` or
`lody/<id>` branch, including collision suffixes. It preserves descriptive branches,
uses a concise task summary without sensitive input, avoids forced replacement on
conflict, and reports rename failure while continuing the task. Existing GitHub rename
guidance remains in the GitHub-only context. Title notifications never trigger renaming.

This extends the agent-guidance approach from the
[ACP-owned titles decision](../architecture/2026-09-08-acp-owned-session-titles.md);
it does not replace that decision's removal of unsafe host prompt-to-ref derivation.
Waiting for titles or restoring an isolated branch generator would reintroduce the
timing and ownership problems recorded there. The
[branch contract](../../../../specs/workspace-branch-state.md) records current intent;
[branch observation](../bug-fix/2026-09-24-workspace-branch-observation.md) remains the
metadata owner.

The first-task context is composed before the shared execution-input resolver runs,
following the [frozen execution-input decision](../architecture/2026-10-08-frozen-turn-execution-input.md).
This preserves accepted Config/Role instructions and structured attachments while adding
branch guidance. Regression coverage observes all three at the provider port and retains
the persisted-turn retry tests for create, continue and restore.

## Verification and limits

Execution tests inspect prompt blocks delivered to ACP across new GitHub/local worktrees,
direct local folders, child Tabs, prior Sessions, and explicit resume requests, with and
without Provider title ownership. Prompt composition covers task references and feedback
context; attachment coverage checks the resulting agent input. A real temporary Git
worktree test renames the branch and verifies owner metadata publication and preservation
after detached HEAD.

Validation after reconciling `main`: 239 distinct tests passed across execution,
prompt helpers, Git observation, shared execution input, selected worktree adoption,
preparation retirement and cold file preview. The execution matrix checks that the
next turn receives only its new input. Final CLI type checking, `pnpm check:quick`
(type-aware lint, i18n and repository boundaries), root `pnpm format`, scoped
formatting and `pnpm run docs check` passed. Dependencies were installed from the
frozen root lockfile and submodules checked out at their merged pins.

Full root `pnpm check` passed workspace type checks and lint but stopped at the
unrelated native recursive SSH submodule fixture (`github-git-transport.test.ts`):
the Lody Git wrapper reports `context_unreadable`, also recorded in the
[frozen-input verification](../architecture/2026-10-08-frozen-turn-execution-input.md#verification).
CLI totals were 3530 passed, 1 failed and 4 skipped; the full pipeline did not
complete. This run preceded the final base refresh; affected execution/preparation/
file-preview suites, CLI types and static/boundary checks were rerun afterward.
Model compliance is not proven by deterministic tests. No live Claude/Codex
invocation or desktop UI smoke test is included.
