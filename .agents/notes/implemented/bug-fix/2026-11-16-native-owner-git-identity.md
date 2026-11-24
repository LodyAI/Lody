# Leave the owner's Git identity to Git

Status: implemented
Translation: current

[中文](2026-11-16-native-owner-git-identity.zh.md)

## Abstract

Lody exported its chosen identity as `GIT_AUTHOR_*`/`GIT_COMMITTER_*` for every turn. Those
variables beat every Git configuration scope, so an owner's repository `user.email` or
`includeIf` identity never reached their commits, and LodyAI won whenever user-level config
was empty. The order also did not match the owner's intent: an unapproved non-owner committed
with their account email, and an owner's "Act as you" approval had no effect because owner
dispatch profiles are placeholders (#1451, part two). The order is now: the owner's repository
identity, then an approved requester, then the owner's other native Git identity, then LodyAI. The environment is set only for a decided
identity, so the owner's own configuration is a real fallback rather than being overridden.

## Decision

- An owner turn whose workdir repository (repository or worktree scope, outside a Lody-managed
  shared clone) configures an identity keeps it even with "Act as you" approved: a per-project
  identity is more specific than an account-wide approval. A non-owner's turn never uses it.
- An approved requester (owner included) exports their account identity. For the owner,
  `SessionManager` performs one account lookup bounded by the 3-second policy deadline; failure
  keeps the local identity for the turn.
- Otherwise the owner's identity is probed in the Session workdir with
  `git config --show-scope --get-regexp`. When usable it is left to Git and nothing is
  exported. If Git has an email but no name, the identity is exported with the email as name,
  matching the previous rule instead of Git's OS-account guess.
- Repository or worktree scope is distrusted only when the workdir's common directory is
  `<data dir>/repos/<repoId>/bare.git`. That shared GitHub clone is the config an agent
  polluted before ([2026-09-30 note](2026-09-30-github-personal-identity-silent-fallback.md)).
  The owner's user-level identity ([XDG reader](2026-10-12-xdg-git-identity.md)), evaluated in
  the workdir so conditional includes apply, or else LodyAI, is then exported. Local projects
  and their worktrees share the user's own repository config, which is the owner's choice.
- Non-owners never read machine identity
  ([ownership boundary](../feature/2026-09-08-machine-owner-git-identity.md)); without approval
  they commit as LodyAI.

## Alternatives

A lowest-priority fallback layer through `GIT_CONFIG_SYSTEM` would track later configuration
changes, but replacing the system file loses `/etc/gitconfig` and Xcode/Git for Windows system
paths differ. The `EMAIL` variable is a true fallback for the email only; Git has no name
equivalent. Probing once per identity resolution keeps Git's own precedence without either.

## Limits

The probe runs when identity is resolved. A Project group workdir is not a repository, so a
GitHub member's shared-clone config inside it is not distrusted. While the environment is not
exported, an agent's own `git config user.email` changes later commits in that Session; the next
Session start detects shared-clone identity again. An existing ACP keeps its launch environment,
as before.

## Verification

Real Git fixtures in `apps/cli/src/session/git-identity.test.ts` cover repository and
`includeIf` identity left to Git, a polluted managed clone replaced by user-level identity, and
the approval matrix. `apps/cli/tests/git-identity.test.ts` covers the bounded owner lookup.
