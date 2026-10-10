# Simple GitHub identity fallback

Status: draft
Translation: current

[中文](github-identity-fallback.zh.md)

## Scope and identity

Managed GitHub sessions try personal credentials belonging to the conversation
owner, then native machine credentials if that owner owns the machine, then an
App token for the actual target repository. Each source is acquired once per
operation. Missing credentials, service failures and failed access advertisement
advance immediately; there is no policy RPC, same-source retry or recovery loop.
Local projects retain native authentication. Commit authorship is separate and
continues to use the frozen turn requester.

The host reads the conversation owner from trusted session metadata; before a
new session is published its creator is its owner. Participant changes do not
change network identity. The host atomically writes a workspace-local context
with an opaque context token and machine-eligibility boolean. Helpers capture it
once. Before a prompt or steer is submitted, validate the current runtime's context
and owner. An owner change revokes its context and machine eligibility, terminates
the old ACP/terminal runtime and reports `github_owner_changed`.
Existing child environments cannot be scrubbed in place. The interrupted operation
is not replayed; a subsequent turn creates a fresh runtime for the new owner.
Host worktree operations carry an immutable context snapshot through
clone/fetch and checkout. Session/host environments install a managed Git credential
helper for checkout filters and LFS, including repository `/info/lfs` paths. Host
non-owner checkout processes cannot inherit machine GitHub token env or shell
startup files. Missing/malformed snapshots are setup errors, not
permission to borrow machine credentials. This is process credential isolation,
not an OS sandbox against processes sharing the same user account.

## Runtime ownership

A logical Session may have successive speculative and live runtime instances.
Each managed instance owns a distinct credential lease and pinned context file,
including when Session ID and owner are unchanged. Successful adoption retains
that lease; cancelled preparation, failed startup and runtime termination release
only the exact acquired generation. An old release must never revoke a replacement.
Local runtimes have no managed lease and never infer authentication from a broker's
historical Session registration. Missing or released managed authority is an error,
not permission to fall back to machine credentials.

Preparation control (expiry/cancellation) ends on claim; adopted runtime resources
continue until the runtime ends. Same-session replacement waits for successful
retirement, including late resource creation. Failed cleanup remains observable
and blocks replacement; a timeout or interrupted waiter does not prove release.

## Providers and availability

A local HTTP broker only supplies personal and App tokens. Its cloud requests
have a 2.5-second deadline; helper requests have a 3-second deadline including
response bodies. Successful credentials may be cached for up to 60 seconds,
partitioned by repository, owner, machine and source and bounded by token expiry.
Failures are not cached. Configuration changes can invalidate the cache; remote
revocation while disconnected is not guaranteed instantaneous.

Broker failure cannot prevent an eligible machine candidate. Broker startup
failure is reported while trusted local context remains usable. Concurrent startup
shares one attempt. No timer restarts or health-recovery loop exists. The MCP
control path does not participate in credential selection.

Personal/App attempts isolate machine credential helpers, authorization headers,
cookies and gh configuration. Managed tokens must not be persisted in native
credential stores or global config. Local attempts restore native settings.
Availability does not change machine eligibility. App tokens remain repository
scoped; changing directory, explicit targets and submodules resolve independently.

## Native execution

Git keeps standard URLs and wire protocols. A workspace `GIT_EXEC_PATH` adapter
intercepts native HTTP helpers and delegates to the installed Git distribution.
Standard GitHub SSH URLs normalize to HTTPS for selection; an eligible machine
candidate can use native SSH, including explicit port 443 and configured commands.
Custom SSH aliases and competing user URL rewrites are outside managed routing.

Before selecting Git credentials, each candidate runs a native read-only
upload-pack or receive-pack advertisement. This is not a GitHub REST permissions
query. It permits fallback before starting a push; the actual transfer runs once.
Branch protections and transfer-time errors are reported without replay. Unknown
Git commands conservatively use receive-pack advertisement. Public anonymous
reads are attempted last; anonymous writes are never selected.

The gh adapter acquires candidates without REST permission preflights and streams
the actual command output. It can advance after failed read-only REST/repository commands with
no output, or a single non-GraphQL, non-paginated REST request explicitly rejected
with HTTP 401/403/404 and no output. Compound commands, GraphQL and uncertain or
partial writes stop with the native exit status: no cross-identity replay.
Unresolved/unsupported gh targets use native auth only for an eligible owner;
otherwise report `repository_required`. Help is credential-free and isolated.

## Observability and limits

Every failed candidate logs source, stage, safe error code, and available HTTP
status/request ID. Selection is visible. Exhaustion exits nonzero with preceding
candidate causes; raw tokens, broker secrets and response bodies are never logged.
Normal native command stderr is preserved. New independent commands start at the
first source; no command asks the agent to retry indefinitely.

No claim is made that this resolves unrelated Stop-hook completion contracts,
MCP daemon availability or remote backend outages. Existing sessions need refreshed
host configuration; legacy custom remotes must be migrated to standard URLs.

## Evidence

Implementation: `github-credential-runtime.ts`, `github-git-transport.ts`,
`gh-shim-script.ts`, token broker/manager and session preparation in the CLI.
Owning suites exercise ordering, provider failure, context ownership, gh write
non-replay, host checkout credentials and native recursive Git cloning with a
failing broker. Production GitHub and Windows end-to-end validation remain open.
