# Git commit identity

Status: draft
Translation: current

[中文](git-commit-identity.zh.md)

Lody resolves the host Session Git identity for every turn based on machine ownership,
rather than workspace size or sharing state. The rules below govern identity resolution;
live ACP propagation has the limitation described below.

For a turn requested by the machine owner, Lody first uses the Git identity effective in the
session worktree and skips the cloud user-profile query, including local Electron turns.
If the machine has no usable Git email, Lody uses the neutral LodyAI identity. For a turn requested by any other workspace member, Lody uses only that
requester's resolved Lody/GitHub identity and never reads or falls back to the machine Git
identity.

Cloud user-profile queries wait at most 60 seconds. Failure or timeout uses a placeholder
for the current turn, which resolves to the neutral Git identity; the next query may retry.
Late results must not replace a newer cached profile. Machine authorization and GitHub
credentials remain separate checks and are never bypassed by this profile fallback.

A missing-email placeholder is not usable. When neither an allowed machine identity nor the
requester's resolved identity is usable, Lody uses the neutral `LodyAI <agent@lody.ai>` identity.
The selected name and email are exported as both Git author and committer environment variables.
GitHub authentication remains a separate requester-bound decision and does not change the commit
object's author or committer.

Changing requester or Git identity must not restart the ACP process or sandbox, including
adopted speculative preparations. The new identity updates the host Session configuration for
subsequent commands launched through it. An existing ACP retains its launch environment, so
Git commands launched directly by that process may retain the previous identity. Live identity
propagation without restarting remains unimplemented.

## Evidence

Identity selection is implemented in `apps/cli/src/session/git-identity.ts`. Initial session
creation applies the ownership policy in `apps/cli/src/session/session-manager.ts`; continued
turns reapply it in `apps/cli/src/session/session-execution-service.ts`.

This draft records the requester-approved policy. Validation for the bounded profile lookup is recorded in the
[implementation note](../.agents/notes/implemented/bug-fix/2026-09-16-bounded-session-user-identity.md);
deployed-client acceptance remains unverified.
