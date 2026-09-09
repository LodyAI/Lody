# Git commit identity

Status: draft
Translation: current

[中文](git-commit-identity.zh.md)

Lody chooses a Git commit identity for every turn before the Agent executes Git commands. The
choice follows machine ownership rather than workspace size or machine-sharing state, so a
sharing change cannot expose the machine owner's identity to another requester.

For a turn requested by the machine owner, Lody first uses the Git identity effective in the
session worktree. If the machine has no usable Git email, Lody uses the owner's resolved
Lody/GitHub identity. For a turn requested by any other workspace member, Lody uses only that
requester's resolved Lody/GitHub identity and never reads or falls back to the machine Git
identity.

A missing-email placeholder is not usable. When neither an allowed machine identity nor the
requester's resolved identity is usable, Lody uses the neutral `LodyAI <agent@lody.ai>` identity.
The selected name and email are exported as both Git author and committer environment variables.
GitHub authentication remains a separate requester-bound decision and does not change the commit
object's author or committer.

An ACP process snapshots its environment at launch. If the effective Git identity changes while
reusing a session, Lody must internally terminate the stale process and resume the same ACP
session with the new environment before submitting the next prompt. This replacement must not
publish the session termination lifecycle or submit that prompt to the stale process. An
unchanged identity does not require a restart. This also applies when an adopted speculative
preparation has a stale identity snapshot.

## Evidence

Identity selection is implemented in `apps/cli/src/session/git-identity.ts`. Initial session
creation applies the ownership policy in `apps/cli/src/session/session-manager.ts`; continued
turns reapply it in `apps/cli/src/session/session-execution-service.ts`.

This draft records the requester-approved policy. The focused identity tests and CLI typecheck
pass in the inspected worktree; deployed-client acceptance remains unverified.
