# GitHub command credentials

Status: draft
Translation: current

[中文](github-command-credentials.zh.md)

The current network authentication contract is [simple identity fallback](github-identity-fallback.md).
It replaces the live policy gate, requester-owned network identity, REST permission
preflights and same-source retry rules of the earlier implementation.

Local projects and their worktrees retain native authentication, even for GitHub
remotes. Do not install managed wrappers, broker contexts or tokens in these sessions.
Managed sessions resolve actual command targets and use conversation-owner personal,
matching-owner machine and repository App credentials once in that order.

Commit authorship is independent of network credentials. A requester with personal identity
enabled commits as their Lody account. The machine owner may otherwise commit
with the machine's global Git identity; repository-level `user.*` in a
Lody-managed bare repository is never read, because every worktree shares it and
an agent's `git config user.name` there would leak into other sessions. Identity
is injected per agent process through `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, so
requesters sharing a machine cannot inherit each other's author.

Host worktree operations carry the prepared PATH, GIT_EXEC_PATH, local configuration
and immutable owner snapshot through clone/fetch and checkout. Missing caller
context is a setup error. Never select a workspace from ambient broker variables.

## Evidence

The owning runtime, native transport, broker, gh and worktree suites cover the
local client boundaries. See the [fallback contract](github-identity-fallback.md)
for execution limits and verification scope; production hosted authorization is
outside this public client's implementation.
