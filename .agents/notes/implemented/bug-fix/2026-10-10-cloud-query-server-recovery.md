# Retry opaque query failures before a render crash

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1398

[中文](2026-10-10-cloud-query-server-recovery.zh.md)

## Abstract

The authenticated query adapter recovered expired authentication but threw ordinary
server failures into rendering. Machine visibility is also read by the runtime
provider above the Outlet boundary, so an intermittent query failure could replace
the whole application. The adapter now shares one watched query and three delayed
retries per client, session and arguments, while the runtime has an explicit outer
boundary. Recovery returns loading instead of stale authorization data; persistent
failures still require manual recovery, and their hosted cause remains unverified.

## Decision and evidence

Convex deduplicates identical watched queries. Retrying one consumer while others
remain subscribed keeps the failed query alive. The adapter therefore owns one
ref-counted watch, releases it during backoff, and ignores the SDK's old cached
error until the new watch receives an update. Timers and callbacks retire with
the watch; session/query identity fences results. A 30-second healthy interval
restores the retry budget, rather than allowing brief success to create a loop.

Only unstructured Convex query `Server Error` messages qualify. Structured
application errors remain actionable failures, and auth expiry retains the
[central supervisor](2026-10-10-bounded-auth-recovery.md). Keeping stale machine
access rows was rejected because it would treat unknown authorization as current.
Resetting a React boundary automatically was rejected because it unmounts the
runtime and removes diagnostics; [manual crash recovery](2026-09-16-renderer-crash-manual-recovery.md)
still applies once retries are exhausted. Optional features still need their
[local boundaries](2026-09-14-share-request-cards-query-isolation.md).
Root auth-invalidation effects remain outside the runtime boundary, so a
runtime failure does not disable confirmed-session-rejection cleanup.

The [hook README](../../../../packages/components/src/hooks/README.md#cloud-query-recovery)
owns the implementation behavior; it does not require a separate Spec.
This change covers authenticated read queries only and leaves public query and
mutation/action handling unchanged. It neither diagnoses nor changes the hosted
implementation of machine visibility.

## Verification and limits

The owning hook suite uses synthetic query results and fake timers to verify
mounted recovery, shared subscriptions, cached-error isolation, exhaustion,
structured failures, auth skips, healthy reset, and cleanup. Runtime containment
is a wrapper in the existing root composition. A production server failure and
its backend logs are outside this checkout's evidence.

Validation passed for the 21 query-hook cases and 100 related auth, visibility,
manual-boundary, platform-provider and session-action cases, plus shared UI
typechecking, changed-file lint and the platform boundary guard. Repository-wide
documentation checks initially encountered eight links into uninitialized Kimi/Grok
submodules; the public boundary check could not resolve Devin/Grok workspace packages.
Initial fetch attempts failed while acquiring GitHub credentials.
The initial root `pnpm check` also stopped in the unchanged Claude adapter build:
its uninstalled dependencies include `@tsconfig/node22`.
No backend change or deployment was performed.

CI passed its static and unit-test checks. Its desktop smoke failure was in
initial harness navigation, before scenario steps; the separate
[harness decision](../testing/2026-10-10-e2e-initial-renderer-navigation.md) records
that fix and validation. Submodules and dependencies were subsequently initialized
locally, and the documentation check now passes.
