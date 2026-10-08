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
rather than reproduced, and full repository and E2E acceptance has not run on the
final source.

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
unadopted and late disposal, adoption across turns, a local session beside a
same-ID context, and the managed missing-policy failure. At `5fe0d97b`, these four
focused suites passed 43 tests with no unhandled rejections; format and typecheck
passed.

Not verified on the final source: the repository-wide check and full desktop E2E.
Runs on an earlier checkout failed a native-SSH fixture with `context_unreadable` and
timed out in `LODY-AGENT-001` and `LODY-ROLE-001`; those causes are not attributed.

## Links

- PR [#1314](https://github.com/LodyAI/Lody/pull/1314), issue
  [#1309](https://github.com/LodyAI/Lody/issues/1309)
- [Local native authentication](../feature/2026-09-29-local-project-native-github-auth.md)
- [Command credentials](../architecture/2026-09-26-github-command-credentials.md)
