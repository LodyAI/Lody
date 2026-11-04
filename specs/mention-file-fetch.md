# GitHub mention file fetching

Status: draft
Translation: current

[中文](mention-file-fetch.zh.md)

Multiple composers and draft hydrators can need the same repository tree before
any mention menu opens. They share a request for the same workspace, repository
and branch; each consumer still receives the result or failure.

## Failure and retry

GitHub and local file discovery failures remain visible to consumers, but do not
emit `mention/file/fetch_error` or `mention/file/local_fetch_error`. Unmounting a
consumer does not cancel a shared request. OSS local telemetry remains
hard-disabled under the platform contract.

Failures are not cached. A subsequent fetch starts a new attempt, even for the
same error value. There is no automatic retry timer; a mounted failed hook retries
on remount or repository / workspace change. The analytics client is not a fetch
dependency.
Reopening the menu alone does not retry discovery (Worker search has its own
retry lifetime).

Keep successful cache freshness and stale refresh behavior. A failed refresh can
retain paths from the same repository; a failed switch must not retain paths
from the previous repository. Background discovery for draft hydration remains.
Removing analytics must not change cache ownership, retry behavior or visible
error state.

## Evidence

- [Cache and request owner](../packages/components/src/lib/repo-file-paths-cache.ts)
- [Mention hook](../packages/components/src/components/mentions/file-at-mention.tsx)
- [Behavior tests](../packages/components/tests/mention-file-fetch.test.tsx)
