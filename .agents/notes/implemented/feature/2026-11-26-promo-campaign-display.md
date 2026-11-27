# Time-windowed promotional campaign display

Status: implemented
Translation: current

English | [中文](2026-11-26-promo-campaign-display.zh.md)

## Abstract

Time-bound Plus promotions span initial-period Checkout, monthly-to-yearly net upgrade quotes, mid-cycle seat invitations, and the public marketing site, where static prerendered discounts would go stale at campaign boundaries. `@lody/cloud-api`, `@lody/components`, and `site-docs` now render server-selected promotional terms, compare initial-period promotions against referral discounts without exposing Stripe Coupon IDs, and overlay active offers on the public landing and pricing pages after hydration. Prerendered HTML keeps standard list prices and client deadline timers expire offers immediately at the server-authoritative boundary with bounded retry backoff on network failure. Hosted Stripe settlement and environment-variable campaign configuration remain verified in the private backend repository rather than in open client tests.

## Decision and ownership

`@lody/cloud-api` adds optional `PromoCheckoutOffer` terms (including optional string or per-locale `PromoCampaignName` labels) on `Pricing`, `promoKind` (`early_bird_forever` or `campaign_once`), `promoDiscountPercent`, and `promoName` on `previewSubscriptionIntervalChange`, and `promoDiscountPercent`, `promoName`, `promoEndsAt`, `regularProratedAmount`, and `policyNextChangeAt` on the `billed` branch of `SeatInvitePreviewSchema`. `getBillingOverview`, `getMyNewWorkspacePricing`, and `getWorkspaceSeatInvitePreview` accept an optional `policyRefreshKey` that clients omit while `0`, so backend and client deployments stay compatible in either order. Clients never receive Coupon IDs or compute upgrade proration amounts locally, and fall back to localized generic labels whenever `name` is omitted.

Workspace creation and Billing reuse the deadline refresh mechanism from [referral campaign display](2026-10-23-referral-campaign-display.md) across both referral and promotional `nextChangeAt` and retained Checkout expiry timestamps. Initial-period promotional offers also render on post-gift renewal setup (`canScheduleAfterGift`), where referral offers do not apply. When both a referral claim and a first-payment promotion are active on a new subscription, the UI displays the higher buyer discount (`max(promo, referral)`, with ties keeping the referral notice) and hides the referral wallet-credit preview whenever a percentage Checkout discount applies; referrer attribution remains server-owned. Monthly-to-yearly switch confirmation distinguishes `campaign_once` net-upgrade discounts—disclosing standard $96 per-seat annual renewal—from grandfathered early-bird accounts, and seat invitation notices show the discounted current-period proration alongside the struck-through standard proration before `promoEndsAt`.

On the public site, prerendered HTML continues to own static list prices ($8 per seat per month billed yearly, $10 billed monthly) as established in [ending the fixed early-bird display](../simplification/2026-10-01-end-yearly-early-bird.md). After mount on `/price` and after first-paint idle inside `OptionalEnhancement` on the landing page, `use-public-promo.ts` fetches the read-only `GET /api/billing/public-promo` payload (resolved against `VITE_CONVEX_SITE_URL` when the static host does not proxy `/api/*`), renders the narrow top banner below the fixed `64px` navigation bar and the Plus card overlay across all 8 site locales, and schedules local expiry using `serverNow` clock-offset math so stale text disappears at `endsAt` without waiting for CDN revalidation.

## Verification

UI and helper behavior are covered in [`referral-campaign.test.tsx`](../../../../packages/components/tests/referral-campaign.test.tsx), [`billing-interval-dialog.test.tsx`](../../../../packages/components/tests/billing-interval-dialog.test.tsx), [`seat-cost-disclosure.test.tsx`](../../../../packages/components/tests/seat-cost-disclosure.test.tsx), and [`public-promo.test.ts`](../../../../site-docs/lib/public-promo.test.ts). Hosted Stripe Coupon creation, Credit Note apportionment, anti-arbitrage history checks, and Cloudflare Pages `VITE_CONVEX_SITE_URL` wiring are outside open-repository verification.
