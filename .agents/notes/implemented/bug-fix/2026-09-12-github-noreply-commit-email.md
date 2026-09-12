# Prefer the GitHub no-reply address for the requester's commit email

Status: implemented
Translation: current

[中文](2026-09-12-github-noreply-commit-email.zh.md)

## Abstract

A session turn exports the requester's resolved commit identity as `GIT_AUTHOR_*`/`GIT_COMMITTER_*`,
and those variables override `~/.gitconfig`, so whatever Lody resolves is what the agent's commits
carry. The resolver preferred the stored account email and fell back to the GitHub no-reply address
only for missing-email placeholders; for an account that enables "Keep my email addresses private"
together with "Block command line pushes that expose my email", that real address makes GitHub
reject every push of an agent commit with GH007, leaving the user unable to ship the work. The fix
inverts that single preference: whenever the profile carries both a GitHub account id and login, the
requester's commit email is `<id>+<login>@users.noreply.github.com`, and the account email is used
only when no such pair exists. The trade-off is that a user whose account email is public and who
expected it on the commit object now sees the no-reply address instead; GitHub attributes both to
the same account, so attribution is unchanged.

## Decision

The GitHub no-reply address is the strictly better commit email whenever it exists. It attributes
the commit to the same GitHub account that later opens the pull request, it is never rejected by
the private-email push block, and it does not publish an address the account chose to keep private.
The stored account email carries no capability the no-reply lacks, so the previous preference only
ever traded a working push for a cosmetically nicer address.

The change is confined to `SessionUserResolver.toSessionUserProfile`. The downstream ownership
policy in `git-identity.ts` is untouched:

- machine owner: effective machine/repository Git identity, then this resolved identity, then the
  neutral `LodyAI <agent@lody.ai>`;
- non-owner requester: this resolved identity, then the neutral identity.

Two alternatives were rejected. Skipping the `GIT_*` export entirely when the host `user.email` is
set would let a remote or multi-user daemon attribute a teammate's turn to the machine owner, which
is exactly what the ownership policy exists to prevent. Adding a user-facing setting was rejected as
out of proportion: the no-reply address is correct for every account that has one, so there is
nothing left to configure.

The worktree archive backup identity is deliberately unchanged; it is machine-local bookkeeping, not
requester attribution.

## Evidence and verification

`apps/cli/src/session/session-user-resolver.ts` implements the preference;
`apps/cli/tests/session-user-resolver.test.ts` covers a real account email plus a complete GitHub
profile resolving to the no-reply address, an incomplete GitHub profile keeping the account email,
and the pre-existing placeholder and fallback paths. Intent is recorded in
`specs/git-commit-identity.md` (still `draft`). The ownership policy this builds on is
[the machine-owner Git identity note](../feature/2026-09-08-machine-owner-git-identity.md).

Verification is the CLI unit suite and typecheck; the GH007 rejection itself is reproduced from the
GitHub push-protection behavior rather than executed in CI, so end-to-end acceptance against a
private-email account remains unverified here.
