# Contain a failed share-request query inside its own boundary

Status: implemented
Translation: current

[中文](2026-09-14-share-request-cards-query-isolation.zh.md)

## Abstract

A failing `sessionSharing:listRequests` query destroyed the conversation: the cloud
query throws out of render, and the pending-share cards sit inside the chat stream,
so the nearest `SessionChatStream` boundary replaced the entire conversation with a
crash screen. The cards now own an inline boundary that degrades to a one-line
retry notice, leaving the conversation mounted while the boundary still reports the
exception. This contains the blast radius only; the backend fault that produced the
server error cannot be diagnosed or fixed from this repository, and a user who hits
it still cannot see pending share requests until the query recovers.

## Evidence

A user-reported renderer error from app 0.87.0, build `bc60f869`:

```
Error: [CONVEX Q(sessionSharing:listRequests)] [Request ID: a99e396cc57c8c07] Server Error
Boundary: SessionChatStream
```

The component stack is `RequestCards` → `SessionShareRequestCards` → … →
`ErrorBoundary`, and the throw originates in `OptimisticQueryResults.queryResult`
reached through `useSyncExternalStore`'s snapshot read. That is the ordinary way a
Convex query reports failure: it throws on every render until the query recovers.
`useCloudQuery` in [`packages/platform/src/react.ts`](../../../../packages/platform/src/react.ts)
returns `Result | undefined` and says nothing about errors, so every consumer
inherits that throw.

Nothing about the failure is specific to the conversation, but the card is rendered
as `leadingContent` of the chat stream, so the boundary that caught it owns the
whole message list. The user loses the conversation over an optional affordance.

## Decision

The feature's own decisions stay in the
[sharing note](../feature/2026-09-09-session-sharing.md); this is only about where
its failures land. `SessionShareRequestCards` wraps `RequestCards` in an inline
`ErrorBoundary` (`resetKeys` on user, workspace and session, matching the existing
remount key).
The fallback is a status line plus **Retry**, which resets the boundary and
re-subscribes; if the backend is still broken the notice comes straight back, and
no automatic reset loop can start because the boundary has no key change to react to.

The boundary keeps its default `propagateAuthErrors`, so an unauthenticated Convex
error still rethrows to the app's auth recovery rather than being shown as a
sharing-specific failure. `componentDidCatch` keeps reporting the exception to
PostHog, so this is containment, not suppression.

Two alternatives were rejected. Making `CloudApi.useQuery` error-tolerant would
change a public platform port contract for all of its consumers and would convert a
hard failure into a silent `undefined` everywhere at once. Rendering nothing on
failure was rejected because a pending request would then be invisible with no
signal — fail-closed for publication, but indistinguishable from "the agent never
asked".

## Verification and limits

`packages/components/tests/session-share-request-cards.test.tsx` renders the cards
under a stand-in conversation boundary with the cloud query throwing, asserts the
conversation boundary never catches, and asserts the cards return after Retry once
the query recovers. The test fails against the previous component.

The server-side cause is out of this repository's boundary: the failing query lives
in the hosted backend, and the request ID above is the only handle on it. Until
that is fixed, affected users see the notice instead of their pending share
requests. Nothing publishable is reachable from the fallback.
