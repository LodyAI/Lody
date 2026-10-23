# Server-selected referral campaign display

Status: implemented
Translation: current

[中文](2026-10-23-referral-campaign-display.zh.md)

## Abstract

Fixed referral percentages can promise the wrong price during a limited-time campaign.
The public client now renders discount and reward percentages from server-selected terms,
including the first payment amount, campaign window and native share title. Query refreshes
follow campaign and retained Checkout deadlines because a subscription does not rerun solely
when time passes. Existing Checkout discounts are distinguished from new-order pricing;
actual charging and reward eligibility remain hosted responsibilities.

## Decision and ownership

This extends the [referral view](2026-10-14-workspace-referral-view.md) and
[uniform credit](2026-10-18-uniform-referral-credit.md) with optional display terms in
`@lody/cloud-api`. Older responses default to the existing 10% discount / 20% reward.
The client never receives Coupon IDs or sends a selected reward percentage. Deploy the
compatible backend before clients start sending `policyRefreshKey`.

The overview, checkout preview, details and share title use the same returned percentages.
The annual/monthly first-payment amount derives from the period price; renewal remains
undiscounted. Campaign dates explicitly display UTC+8, with an exclusive end. Current
new-order pricing and an existing Checkout's retained discount are separate statements,
because changing plan, seats or return destination can create a new order.

The shared refresh hook follows the next server deadline, retries while the server still
returns the old boundary (client clock skew), and checks focus/visibility after suspension.
Checkout also refreshes at retained Session expiry. No always-running minute poll is needed
outside a pending boundary. Analytics attach the displayed campaign ID and percentages
without changing event identities or deriving payment success from browser navigation.

## Evidence and limits

Deterministic UI tests cover the annual campaign price, retained/new-order distinction,
clock-ahead retry and focus recovery. Storybook includes campaign, annual checkout and
retained checkout states. Backend tests own monetary and eligibility invariants. No live
Stripe payment or production deployment is implied by this source change.

PR: https://github.com/LodyAI/Lody/pull/1812
