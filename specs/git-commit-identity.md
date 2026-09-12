# Git commit identity

Status: draft
Translation: current

[中文](git-commit-identity.zh.md)

Lody resolves the host Session Git identity for every turn based on machine ownership,
rather than workspace size or sharing state. The rules below govern identity resolution;
live ACP propagation has the limitation described below.

For a turn requested by the machine owner, Lody first uses the Git identity effective in the
session worktree. If the machine has no usable Git email, Lody uses the owner's resolved
Lody/GitHub identity. For a turn requested by any other workspace member, Lody uses only that
requester's resolved Lody/GitHub identity and never reads or falls back to the machine Git
identity.

A requester's resolved Lody/GitHub identity uses the GitHub no-reply address
`<id>+<login>@users.noreply.github.com` whenever the profile carries both a GitHub account id and
login, in preference to the stored account email. That address attributes the commit to the same
GitHub account, and it is the only one accepted by an account that keeps its email private and
blocks command-line pushes that expose it. The stored account email is used only when no GitHub
account id and login are available.

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

Identity selection is implemented in `apps/cli/src/session/git-identity.ts`, and the requester's
Lody/GitHub identity in `apps/cli/src/session/session-user-resolver.ts`. Initial session
creation applies the ownership policy in `apps/cli/src/session/session-manager.ts`; continued
turns reapply it in `apps/cli/src/session/session-execution-service.ts`.

This draft records the requester-approved policy. The focused identity tests and CLI typecheck
pass in the inspected worktree; deployed-client acceptance remains unverified.
