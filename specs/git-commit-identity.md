# Git commit identity

Status: draft
Translation: current

[中文](git-commit-identity.zh.md)

Lody resolves the host Session Git identity for every turn from the requester's approval and
machine ownership, rather than workspace size or sharing state. The precedence is:

1. for a turn requested by the machine owner, an identity configured in the session workdir's
   own repository (repository or worktree config);
2. the requester's own Lody/GitHub identity, only when that requester approved "Act as you";
3. for a machine-owner turn, any other identity Git itself resolves in the session workdir;
4. the neutral `LodyAI <agent@lody.ai>` identity.

A repository identity is the owner's most specific choice for that project, so it also wins
over the owner's "Act as you" approval.

Lody exports an identity as Git author and committer environment variables only when it has
decided one: an approved requester, LodyAI, or a replacement described below. Those variables
override every Git configuration scope, so the owner's own setup is otherwise left to Git:
repository and worktree config, conditional includes, user-level config and the daemon's
environment keep working as in a plain `git commit`. Repository config of a Lody-managed shared
GitHub clone is the exception. Agents can write it and every Session on that repository shares
it, so an identity coming from it is replaced by the owner's user-level identity, or LodyAI.

A turn requested by any other workspace member never reads or falls back to the machine Git
identity. Without approval it commits as LodyAI; the requester's account email does not enter
the commit. The owner's dispatch profile is a placeholder, so an approved owner turn performs
one bounded account lookup; failure keeps the owner's local identity for that turn.

Cloud user-profile queries wait at most 60 seconds. Failure or timeout uses a placeholder
for the current turn, which resolves to the neutral Git identity; the next query may retry.
Late results must not replace a newer cached profile. Machine authorization and GitHub
credentials remain separate checks and are never bypassed by this profile fallback.

A missing-email placeholder is not usable. GitHub authentication remains a separate
requester-bound decision and does not change the commit object's author or committer.

Changing requester or Git identity must not restart the ACP process or sandbox. The new
identity updates the host Session configuration for
subsequent commands launched through it. An existing ACP retains its launch environment, so
Git commands launched directly by that process may retain the previous identity. Live identity
propagation without restarting remains unimplemented.

## Evidence

Identity selection is implemented in `apps/cli/src/session/git-identity.ts`. Initial session
creation applies the ownership policy in `apps/cli/src/session/session-manager.ts`; continued
turns reapply it in `apps/cli/src/session/session-execution-service.ts`.

This draft records the requester-approved policy; the approval precedence and native owner
configuration are explained in the
[native identity note](../.agents/notes/implemented/bug-fix/2026-11-16-native-owner-git-identity.md). Validation for the bounded profile lookup is recorded in the
[implementation note](../.agents/notes/implemented/bug-fix/2026-09-16-bounded-session-user-identity.md);
deployed-client acceptance remains unverified.
