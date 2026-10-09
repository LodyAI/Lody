# Verify temporary branches before requesting agent naming

Status: implemented
Translation: current

[中文](2026-10-09-daemon-branch-naming-eligibility.zh.md)

## Abstract

The first-task prompt asked the agent to inspect whether its branch was temporary,
adding an agent tool call for a fact the daemon can determine. Execution now checks
the actual checkout after setup and directly requests naming only for this Session's
allocated ref. Unknown or descriptive branches skip naming; the agent still owns the
new name and Git operation. No live model tool-call savings have been measured.

## Decision

This refines [the original naming guidance](../feature/2026-10-08-new-worktree-branch-prompt.md).
First-use eligibility remains unchanged, including prepared-worktree adoption and the
exclusion of direct folders, child Tabs, prior/resumed Sessions, later turns and Fork.
Only eligible starts read `git branch --show-current` after `createSession` completes.
Creation and recognition share the allocation scheme, including numeric name and
namespace collisions. Match the current Session's id rather than a broad `lody/`
prefix. Detached HEAD, other Sessions' refs and probe failure skip the instruction
without preventing task execution. Presentation metadata is not a source for this check.

The prompt names the verified old ref in `git branch -m <old> <name>`, so a later
checkout cannot redirect it to a different branch. It keeps compact requirements
for descriptive naming, sensitive-input exclusion, collision handling and reporting
rename failure while continuing. This adds one daemon Git probe on eligible starts
while removing an agent inspection request; it does not enforce model compliance.
Frozen Config/Role text and attachments still use the shared execution-input resolver.
The [branch contract](../../../../specs/workspace-branch-state.md) remains draft.

## Verification and limits

Provider-port tests cover both namespaces, name/namespace collisions, descriptive
branches, another Session's ref, detached HEAD and probe failure with title ownership
on/off. They also retain attachments, frozen instructions and later-turn exclusions.
Allocation tests check recognition against the actual collision allocator.

Validation: the execution, prompt, Git observation and allocation suites passed
217 tests. Root `pnpm check` passed workspace type checks and lint, then stopped
at the pre-existing native recursive SSH submodule fixture (`github-git-transport.test.ts`)
with the Lody Git wrapper's `context_unreadable`; CLI totals were 3574 passed,
1 failed and 4 skipped. The full pipeline did not complete. Root formatting and
scoped formatting, documentation, i18n and repository boundary checks passed. No live Claude/Codex call or desktop UI smoke test
was performed.
