# Explain personal GitHub fallback and stop reading shared bare-repo identity

Status: implemented
Translation: current

[中文](2026-09-30-github-personal-identity-silent-fallback.zh.md)

## Abstract

With "Act as you" enabled, sessions on a machine without local GitHub credentials
still pushed and opened PRs as the workspace GitHub App, while commits were
authored as `Test User <test@example.com>`. The credential precedence
(personal → owner-local → App) was already correct; the backend reported the
personal token as `personal_token_refresh_failed`, the CLI reduced that to
`available: false` with no message, and the settings page kept showing the
identity as connected. Helpers now print the backend reason, and a
GitHub-confirmed dead refresh token clears the stored pair so settings ask for
re-authorization. Commit identity follows the same precedence and the machine
identity is read from global Git config only, never from the bare repository that
every Lody worktree shares. What remains unverified is why the refresh token died
on the affected account; the fix makes the state visible and repairable, it does
not prevent it.

## Problem

Live probe on the affected machine (session broker + Convex action):

- `/github-auth-context` → `personalEnabled: true, allowLocalAuth: true`
- `/github-token` personal → `available: false`; the backend said
  `personal_unavailable / personal_token_refresh_failed`
- no `gh` login and no Git credential helper on the machine → App token

So the selector behaved as specified. The defects were observability and state:

1. `GitHubTokenManager.getCredentialCandidate` returned `null` for
   `personal_unavailable`, discarding the reason; the helper printed only
   `(personal access unavailable)`.
2. `getPersonalOperationSettings` reported `authorized` whenever
   `refreshTokenExpiresAt` was in the future. The refresh-failed branch is only
   reachable under exactly that condition, so this account always looked healthy.
3. `readHostDefaultGitIdentity` ran `git config user.name` in the worktree. Lody
   worktrees share one bare repository config, and a past agent had written a
   fixture identity there. Every owner session on that repository inherited it.

## Decision

- Candidate lookups return `{ available: false, reason }`; the broker forwards
  the reason; `selectGitHubCredential` prints an actionable sentence per reason
  (not authorized / expired or revoked / no repository access / token rejected)
  whenever it falls back to local or App identity. Reasons are policy codes, not
  token material.
- Backend (private repository): when GitHub answers a refresh with
  `bad_refresh_token`, `invalid_grant` or `expired_token` and no newer pair was
  persisted concurrently, the account's token pair is cleared. The settings query
  then reports `missing` and the existing Authorize button re-links.
- Commit identity: a requester with personal identity enabled commits as their
  Lody account. The machine owner otherwise gets the machine's **global** Git
  identity; repository-level config is never consulted. `SessionManager`
  resolves `{ preferMachineIdentity, personalIdentityEnabled }` from the
  credential policy per requester, including requester switches mid-session.
  Identity is still injected per agent process via `GIT_AUTHOR_*` /
  `GIT_COMMITTER_*`, which is what keeps requesters on one machine separate.

Alternatives considered: enabling `extensions.worktreeConfig` to isolate
per-worktree identity. A plain `git config user.name` in a linked worktree still
writes to the shared config (only `--worktree` targets `config.worktree`), so it
would not have stopped the pollution; reading global scope only does.

## Verification

- `github-credential-runtime.test.ts`: fallback to App and to local each print
  the reason-specific sentence.
- `github-token-manager.test.ts`, `git-credential-broker.test.ts`: the reason
  round-trips without a token.
- `git-identity.test.ts`: personal wins on the owner's machine; owner without
  personal keeps machine identity; non-owner never gets it; a repository-level
  `user.*` is ignored.
- Private backend test: a rejected refresh clears the pair.

Not verified: a real GitHub re-authorization after clearing (relies on
BetterAuth `linkSocial` updating the existing account row), and the origin of
the dead refresh token.
