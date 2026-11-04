# Billing funnel telemetry

Status: implemented
Translation: current

English | [中文](2026-10-18-billing-analytics.zh.md)

## Abstract

Billing settings lacked a funnel from page entry to checkout. The shared container now
records visits, checkout handoff and return, Portal actions, interval
changes, and promotion redemption using sanitized PostHog events. Payment outcomes
remain owned by the hosted backend; a browser return or gift activation cannot prove
a charge. Telemetry is best effort and local builds retain their existing capability gate.

## Decision and boundaries

Use low-volume unsampled `billing/*` events. `page_viewed` fires once per mounted
auth-session/workspace scope, not on live overview refresh or StrictMode replay.
`checkout_started` precedes the upgrade request; `checkout_redirected` precedes
the URL handoff; `checkout_failed` reports an opening error. `checkout_returned`
records only a success/canceled navigation marker. Promotion checkout is distinguished
by `source=promotion_code`; normal upgrade uses `source=upgrade`.
Portal records opened/failed. Interval changes and redemption use one result event
with an outcome; auxiliary started and interval-selection events are omitted.
Redemption results expose the backend status, never the bearer code.
Do not report client payment success from plan changes, polling, or return URLs.

Workspace IDs, selected intervals and allowlisted failure categories are sufficient;
URLs, codes and exception messages are excluded. Existing PostHog sanitation and
platform gating are reused. No billing API, entitlement or persistent schema changes
are needed in this public package. Server invoice analytics is a separate hosted concern.

## Verification

The existing checkout confirmation suite covers return markers and live activation.
It also checks StrictMode visit deduplication and that success/canceled returns never
emit payment outcomes. Local checks do not prove production PostHog delivery.
