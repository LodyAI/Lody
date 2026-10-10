# Bounded cloud query recovery

Status: draft
Translation: current

[中文](cloud-query-recovery.zh.md)

## Behavior

An opaque server failure in an authenticated cloud query first enters local loading
and retries up to three times, with delays of 1, 2 and 4 seconds. Consumers of the
same client, authentication session, function and arguments share one subscription
and budget. Each retry releases the failed subscription and waits for a fresh server
update; a cached error must not consume another attempt. No stale authorization rows
are returned during server-error recovery.

Brief success and temporary authentication skips do not replenish attempts. Thirty
seconds of continuously observed successful results resets the budget. Explicitly
skipped or unmounted queries perform no background retries. Changed sessions or query
arguments cannot adopt another scope's results or pending retry callbacks.

Structured application errors are not automatically retried. Authentication expiry
uses the separate [auth recovery contract](auth-recovery.md). Public queries,
mutations and actions retain their existing behavior; this does not enable cloud
requests in local-only clients.

Exhausted query failures throw to the nearest React boundary. The runtime provider
is covered above the Outlet boundary. The copyable crash screen remains visible
until explicit user recovery. Persistent runtime query failures can still replace
the application with that screen; this contract does not guarantee that unavailable
cloud data can be used or establish why the hosted query failed.

## Evidence

- Adapter: `packages/components/src/hooks/use-recoverable-convex-query.ts`.
- Runtime containment: `packages/components/src/routes/__root.tsx`.
- Behavioral tests: `packages/components/tests/use-recoverable-convex-query.test.tsx`.
