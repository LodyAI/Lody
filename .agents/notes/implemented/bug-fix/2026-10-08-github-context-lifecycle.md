# Scope GitHub broker contexts to their holders

Status: implemented
Translation: current

[中文](2026-10-08-github-context-lifecycle.zh.md)

## Abstract

An abandoned speculative preparation could leave a GitHub broker context under a
session ID, and turn-start refresh treated that membership as managed enrollment,
failing a later local-project turn with `github_context_missing`. Broker contexts are
now leases released by unadopted preparations, and refresh skips local projects as
preparation does; managed sessions still fail closed on a missing policy. The desktop
interaction that left the stale context is inferred, not reproduced, and the tests were
written but not run by the authoring agent.

## Evidence

Confirmed: the failing turn logged `execution.refresh_gh_token status=error
durationMs=0` after the same local session's first refresh succeeded, with the agent
already running. Running the installed bundle's own preparation, membership, refresh
and policy methods, a local session without a policy failed only when a context existed
for its ID. In source, membership was refresh's only gate, preparation registered its
context before its final abort check, and cleanup never revoked it.

Inferred: cancellation and claim misses do not wait for in-flight credential setup, so
an abandoned managed preparation can register after a cold-started local session's
first refresh. This matches the log, but the user interaction that started it is
unconfirmed.

## Decision

`GitCredentialBroker.acquireSessionContext` returns an idempotent lease counted per
session ID; the last release revokes the current token and files, even after owner
rotation. Preparation acquires last, releases on abort, failure or unadopted disposal,
and hands the lease over on adoption. Durable sessions keep contexts until shutdown,
whose generation bump stops older leases releasing newer contexts. Refresh returns for
local projects before checking membership; managed sessions without a policy still fail
closed, and owner changes still terminate old processes.

Rejected: removing the missing-policy guard or giving local sessions a policy would hide
managed setup errors or enroll local sessions; revoking on every disposal would let a
late disposal revoke the replacing session's shared token; gating only on the live
policy would drop the managed fail-closed check.

Limits: durable contexts are still not released on session termination, and a stale
preparation resolving a different owner still rotates the token.

## Verification

Regression tests cover broker leases (shared holders, owner rotation, shutdown) and the
real preparation runtime: abort during credential setup, unadopted and late disposal,
adoption across turns, local sessions beside a foreign context, and the managed
missing-policy failure. They were not executed in the authoring environment. Related:
[local native authentication](../feature/2026-09-29-local-project-native-github-auth.md),
[command credentials](../architecture/2026-09-26-github-command-credentials.md),
issue [#1309](https://github.com/LodyAI/Lody/issues/1309).
