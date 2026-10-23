# Referral funnel and credit telemetry

Status: implemented
Translation: current

[中文](2026-10-23-referral-analytics.zh.md)

## Abstract

Referral credit needs observable acquisition and usage milestones without allowing analytics
failures to interrupt billing or login. The shared client now records first stored referral
observation, visible referral cards, successful copying/sharing and details opens through the
existing PostHog client. Platform telemetry gates every call; no referral URL or raw code is sent.
Browser events measure interactions, while hosted services remain authoritative for attribution,
payments and credit accounting. Delivery is best-effort and does not establish financial truth.

## Decision

The existing `referral-attribution.ts` hint remains first-touch, valid for 30 days. A new
`analyticsCapturedAt` field records one telemetry attempt when the app observes that valid hint;
it never alters its code or expiry. Static landing redirects already share that hint, so they
need no analytics SDK or second attribution store. Static-only bounces and dropped deferred
analytics events are deliberately outside this measurement; old unmarked hints may be observed
on their next app launch. The event is named `referral/landed` with `source=stored_attribution`,
not a count of every link click or unique person.

The PostHog provider observes hints only when telemetry and project configuration are present.
The billing card sends `referral/viewed` once per workspace visit after it is loaded and visible,
`referral/details_viewed` on opening details, `referral/link_copied` after clipboard success and
`referral/link_shared` after native share completion. Sharing does not prove recipient engagement.
Referral codes use the existing analytics hash to correlate interactions without exposing the code;
URLs and raw errors are excluded. Events are low-volume and unsampled. Failed capture is contained
so successful clipboard actions and the underlying attribution survive.

No new cloud protocol or financial calculations are added. Local composition keeps telemetry disabled. [Referral view ownership](2026-10-14-workspace-referral-view.md) and
[uniform credit](2026-10-18-uniform-referral-credit.md) retain their product contracts.

## Evidence and limits

Behavioral tests exercise static-style hints, expiry, missing clients, analytics failures,
StrictMode/rerender view deduplication, workspace changes, copy success/failure, privacy and disabled
telemetry. These tests do not verify production PostHog ingestion or real payment flows.
The change extends [PR #1812](https://github.com/LodyAI/Lody/pull/1812).
