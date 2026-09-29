# GitHub command credentials

Status: draft
Translation: current

[中文](github-command-credentials.zh.md)

Local projects and their worktrees use native Git and GitHub authentication,
even when their remote is GitHub. Do not install Lody credential helpers, command
wrappers, transport rewrites, broker context, or managed tokens for these sessions.
Preserve the user's environment, credential helpers, SSH configuration, and `gh`
login. Later requester refreshes must not enroll a local session in managed auth.
The managed command policy below applies to sessions outside local projects.

When an agent changes directories, addresses another repository with `gh -R`, or
uses a submodule, credentials belong to that command's target, not the session's
initial project. Installation tokens remain scoped to one repository.

The driving requester owns the credential choice. With personal identity enabled,
try personal identity first, refreshing invalid tokens before fallback. The machine
owner may then use local credentials; other members may not. Finally use the
workspace GitHub App. With personal identity disabled, omit that first step.

Use read-only permission checks before executing the command. Confirmed missing
credentials or repository access can advance the chain. Network failures, generic
403 responses, rate limits, and branch rules do not justify changing identity.
Never replay an uncertain write. Report fallback identity without logging secrets.

For `gh`, preflight known target-repository requirements: push access for merging,
release writes, workflow/run writes and repository sync; admin for repository
archive/delete/rename. Do not equate every write with push access: comments,
reviews, fork-head updates and mixed-permission commands keep a read preflight.
Token scopes, rules and command-specific restrictions can still reject execution;
such failures never cause a write to be retried with another identity.
If managed/personal identity is required but a command's target cannot be resolved,
explain that boundary and suggest `-R` where supported or a separately authenticated
terminal. Never silently bypass the personal preference.

Unavailable policy is different from expired context. Report connection/access
recovery for policy failures, not an unconditional session restart. Do not use a
cached preference to bypass a newly selected personal identity during an outage.

Helpers must not save managed tokens into local credential stores. Recovery stays
within the workspace broker. Broker context is bound to the active requester;
inherited environment variables cannot prove machine ownership. This policy is
not an operating-system sandbox against processes sharing the same OS account.

GitHub HTTPS and standard GitHub SSH remotes share per-remote selection, including
recursive submodules. Local SSH command configuration and port 443 are preserved.
Unknown Git commands are conservatively checked for write access. Custom SSH host
aliases, embedded URL credentials, and commands bypassing the managed shell paths
are outside this contract. User-defined Git URL rewrites can also change the host;
network commands reject competing GitHub `insteadOf` / `pushInsteadOf` rules
explicitly rather than bypassing identity selection. This is not a general-purpose
credential firewall. Public repositories may use verified anonymous read access
when no applicable credential exists; writes never use anonymous fallback.

Persistent agent processes read a session context file at each helper launch; a
requester switch rotates its token without restarting the agent. A helper captures
one context and cannot mix two requesters while resolving a credential. Background
commands launched after a switch use the then-current requester, not the identity
of the turn that originally scheduled them.

Host-side worktree preparation follows the same requester policy before an agent
exists. Carry one explicit credential context through clone/fetch, checkout and
checkout retries, including credential-using smudge filters. Worktree creation owns
remote preparation; a preliminary fetch cannot authorize later operations. Native
broker-less execution does not install managed credential helpers. Missing caller
context is a Lody setup error, not a request for the user to reauthorize GitHub.

## Evidence and validation

Implementation: CLI `github-credential-runtime.ts`, `gh-shim-script.ts`,
`git-credential-helper-script.ts`, and session credential preparation.
Deterministic command/helper tests cover precedence, target repositories, context
rotation, redirects, inherited HTTP headers and SSH transport arguments. A native
Git fixture verifies that receive-pack advertisement does not change refs and
that recursive submodule cloning uses the generated transport. Real
GitHub end-to-end validation is not claimed; hosted authorization and lifecycle
behavior are outside this public client's implementation boundary.
