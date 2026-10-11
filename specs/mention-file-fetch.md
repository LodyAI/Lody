# GitHub mention file fetching

Status: draft
Translation: current

[中文](mention-file-fetch.zh.md)

Multiple composers and draft hydrators can need the same repository tree before
any mention menu opens. They share a request for the same workspace, repository
and branch; each consumer still receives the result or failure.

## Failure and retry

A shared tree-fetch attempt with a mention observer emits at most one
`mention/file/fetch_error` event through the existing telemetry client, after
existing token retry handling finishes. Unmounting a consumer does not cancel
that request or its failure accounting. The duration covers the shared attempt,
not each consumer's cache read. Repository identifiers remain hashed when
visibility is unknown; raw error messages are not analytics properties. OSS local
telemetry remains hard-disabled under the platform contract.

Failures are not cached or sampled away. A subsequent fetch starts a new attempt
and can emit another failure, even for the same error value. There is no new
automatic retry timer; a mounted failed hook retries on remount or repository /
workspace change. Changing the analytics client alone must not fetch again.
Reopening the menu alone does not retry discovery (Worker search has its own
retry lifetime).

Keep successful cache freshness and stale refresh behavior. A failed refresh can
retain paths from the same repository; a failed switch must not retain paths
from the previous repository. Background discovery for draft hydration remains.
This contract counts logical attempts, not individual HTTP calls, and does not
establish the cause or frequency of production service failures.

## Evidence

- [Cache and request owner](../packages/components/src/lib/repo-file-paths-cache.ts)
- [Mention hook](../packages/components/src/components/mentions/file-at-mention.tsx)
- [Behavior tests](../packages/components/tests/mention-file-fetch.test.tsx)
