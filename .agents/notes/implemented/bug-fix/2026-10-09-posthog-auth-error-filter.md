# Filter expected authentication exceptions before PostHog ingestion

Status: implemented
Translation: current

[中文](2026-10-09-posthog-auth-error-filter.zh.md)

## Abstract

Expected Convex authentication failures could flood PostHog Error Tracking even
though authentication recovery already handled some callers. The shared PostHog
`before_send` hook now drops exception events matching the structured
`lody.auth` / `unauthenticated` contract, including nested Convex messages.
Other exceptions and mixed exception chains remain reportable. This changes
client reporting only; backend authorization and authentication recovery remain
unchanged, and deployed older clients can still report these events.

## Decision and verification

The shared provider covers automatic capture and explicit `captureException`.
PostHog serialization removes the original Convex error identity, so the filter
parses the JSON payload in the exception message and reuses
`isConvexAuthErrorData`. It does not suppress arbitrary messages containing
"unauthenticated", other namespaces or codes, malformed payloads, or analytics
events. Every entry in an exception list must match before the event is dropped.
Keeping the backend guard preserves authorization; filtering only individual
callers would miss other capture paths.

The existing provider suite exercises the actual `before_send` callback with
serialized `ConvexError` messages, nested action/query messages, mixed chains,
and unrelated events. Production ingestion is not verified by this local test;
the filter takes effect only after clients receive the updated bundle.
