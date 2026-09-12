# Use the GitHub no-reply commit email on GitHub remotes only

Status: implemented
Translation: current

[中文](2026-09-12-github-noreply-commit-email.zh.md)

## Abstract

A session turn exports the requester's resolved commit identity as `GIT_AUTHOR_*`/`GIT_COMMITTER_*`,
and those variables override `~/.gitconfig`, so whatever Lody resolves is what the agent's commits
carry. Lody resolved the stored account email, which for an account with "Keep my email addresses
private" plus "Block command line pushes that expose my email" is exactly the address GitHub
rejects: every push of an agent commit failed with GH007 and the user could not ship the work. The
fix makes the account's `<id>+<login>@users.noreply.github.com` address win, but only in a session
workdir that pushes to github.com — the address attributes nothing on GitLab or a GitHub Enterprise
host and may be rejected there, so those repositories keep resolving through Git configuration and
the account email as before. Because the resolver is cached per user and never sees a workdir, the
no-reply address is now reported beside the account email and the workdir's remotes decide between
them; the residual limit is that hosts such as `ssh.github.com` are not recognised as GitHub, which
costs those users the fix rather than breaking them.

## Decision

Two facts do not live in the same place. `SessionUserResolver` knows the requester's GitHub account
but is cached per user across every session, so it cannot see a workdir. `resolveSessionGitIdentity`
runs per turn with the session `cwd` but knows nothing about the account. The no-reply address is
therefore resolved as a second, clearly-typed value (`SessionUserProfile.githubNoreplyEmail`,
carried to the turn as the optional `userGitHubNoreplyEmail` request field) and the decision is
taken where `cwd` exists. The account email keeps its own meaning, so the non-GitHub fallback order
is unchanged rather than silently replaced by a GitHub address.

The resulting order in `resolveSessionGitIdentity` is:

- github.com remote and a usable GitHub account id and login: the no-reply address, ahead of the
  machine Git identity, because that identity is what GH007 rejects for these accounts;
- otherwise the existing policy — machine owner: effective machine/repository Git identity, then
  the requester's account email, then neutral `LodyAI <agent@lody.ai>`; non-owner: the requester's
  account email, then the neutral identity, never the machine owner's configuration.

`origin` decides the host alone when it exists: a repository whose origin is GitLab is not a GitHub
repository because it also has a GitHub mirror. Only `github.com` and `gist.github.com` count, so a
GitHub Enterprise installation — whose accounts have different ids and no `users.noreply.github.com`
attribution — is excluded. The push URL wins over the fetch URL because the push is what GitHub can
reject. `GIT_*` stays exported in every branch: dropping it when the host Git configuration is set
would attribute a teammate's turn on a shared daemon to the machine owner, which the ownership
policy exists to prevent.

Two alternatives were rejected. Letting the resolver keep choosing the no-reply address and having
the Git layer merely demote it off GitHub needs no new plumbing, but the account email is gone by
then, so a GitLab user without Git configuration would commit as `LodyAI` instead of themselves.
Re-resolving the requester profile at `updateGitIdentity` time avoids the request field but reads
identity outside the frozen turn, which [the session rules](../../../../apps/cli/src/session/AGENTS.md)
forbid. A user-facing setting was rejected as disproportionate: on github.com the no-reply address
is correct for every account that has one, and off it the address is simply wrong.

The worktree archive backup identity is deliberately unchanged; it is machine-local bookkeeping,
not requester attribution.

## Evidence and verification

`apps/cli/src/session/git-identity.ts` holds the remote inspection and the resolution order, and
`apps/cli/src/session/session-user-resolver.ts` reports the address beside the account email.
`apps/cli/tests/git-identity.test.ts` covers https and ssh GitHub origins, a gitlab.com origin, a
remote-less repository, a GitHub mirror behind a GitLab origin, a GitHub Enterprise host, an
incomplete GitHub profile, and the non-owner and neutral fallbacks — the last three cases through
real temporary repositories so the `git remote -v` and `git config` reads are exercised, with the
inherited `GIT_AUTHOR_*`/`GIT_COMMITTER_*` environment stubbed out so the repository configuration
is what answers. `apps/cli/tests/session-user-resolver.test.ts` covers the split fields. Intent is
recorded in `specs/git-commit-identity.md` (still `draft`). The ownership policy this builds on is
[the machine-owner Git identity note](../feature/2026-09-08-machine-owner-git-identity.md).

The full `apps/cli` suite passes except the pre-existing `tests/worktree-gc.test.ts` macOS
`/private/var` path mismatch, which fails identically without these changes. The GH007 rejection
itself is taken from GitHub's push protection rather than reproduced in CI, so end-to-end
acceptance against a private-email account remains unverified.
