# Scope GitHub broker contexts to their holders

Status: implemented
Translation: current

[中文](2026-10-08-github-context-lifecycle.zh.md)

## Abstract

A local-project session could fail a later turn with `github_context_missing`: an
abandoned speculative preparation left a GitHub broker context under the session's
ID, and turn-start refresh treated any context as managed enrollment. Broker contexts
are now counted leases that unadopted preparations release, and refresh skips local
projects before checking for a context. Managed sessions still fail closed on a
missing policy. The desktop interaction that leaves the stale context is inferred
rather than reproduced.

## Evidence

Confirmed:

- The failing turn logged `execution.refresh_gh_token status=error durationMs=0`
  after the same local session's first refresh had succeeded and its agent was running.
- Calling the installed bundle's own preparation, membership, refresh and policy
  methods, a local session without a policy failed only when a context existed for
  its ID.
- In source, context membership was refresh's only gate, preparation registered its
  context before its last abort check, and preparation cleanup never revoked it.

Inferred: cancellation and claim misses do not wait for in-flight credential setup,
so an abandoned managed preparation can register its context after a cold-started
local session's first refresh. This fits the log; the user interaction that starts
the race is unconfirmed.

## Decision

- `GitCredentialBroker.acquireSessionContext` returns an idempotent lease, counted
  per session ID. A preparation and the durable session replacing it may hold the
  same context; the last release revokes the current token and its files, including
  a token replaced by owner rotation.
- Preparation acquires its lease after every other credential step. It releases the
  lease on abort, failure or unadopted disposal, and hands it to the durable session
  on adoption.
- Fork worktree cleanup, which prepares credentials only to resolve the repository,
  releases its lease once the worktree is removed.
- Durable sessions keep their context until broker shutdown. Shutdown advances a
  lease generation, so a lease issued before it cannot release a later context.
- Refresh returns for local projects before checking membership, mirroring
  preparation. A managed session without a policy still fails closed, and an owner
  change still terminates its old processes.

Rejected alternatives:

| Alternative                                    | Why rejected                                           |
| ---------------------------------------------- | ------------------------------------------------------ |
| Remove the missing-policy guard                | Hides managed setup errors                             |
| Give local sessions a policy                   | Enrolls local projects in managed credentials          |
| Revoke on every preparation disposal           | A late disposal revokes the token its successor shares |
| Gate refresh only on the session's live policy | Drops the managed fail-closed check                    |

## Limits

- Durable contexts are not released when their session terminates; they live until
  broker shutdown.
- A stale preparation that resolves a different owner can still rotate the shared
  token.

## Verification

Behavioral tests cover broker leases (shared holders, owner rotation, shutdown
generations) and the real preparation runtime: abort during credential setup,
unadopted and late disposal, adoption across turns, fork worktree cleanup, a local
session beside a same-ID context, and the managed missing-policy failure. The fork
cleanup test fails against the previous implementation.

At `db4e77b2`, the five focused suites passed 87 tests with no unhandled rejections;
the repository-wide check (10,768 passed, 7 skipped), docs check, desktop build, and
the agent, session and fork E2E scenarios passed. The full E2E suite was not run to
completion; scenarios outside this change that failed in the partial run were not
attributed.

## Links

- PR [#1314](https://github.com/LodyAI/Lody/pull/1314), issue
  [#1309](https://github.com/LodyAI/Lody/issues/1309)
- [Local native authentication](../feature/2026-09-29-local-project-native-github-auth.md)
- [Command credentials](../architecture/2026-09-26-github-command-credentials.md)
