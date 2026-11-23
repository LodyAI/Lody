# Clarify gift billing periods and the first post-gift charge

Status: implemented
Translation: current

English | [中文](2026-10-18-gift-billing-history-clarity.zh.md)

## Abstract

A single multi-month Plus gift produced one zero-dollar invoice per service month, while every row repeated the gift's total duration; the history therefore looked like several separate grants. Gift invoice rows now describe their individual service periods, and a scheduled post-gift subscription exposes its next charge date, amount, and reason whenever the backend can estimate them. When an amount is not yet available, the UI shows only the authoritative start date and says that the amount is pending instead of calculating a potentially incorrect total in the client.

## Decision

Gift invoice records remain separate because each is a real billing record and may open its own invoice details. Their generic `periodStart` and `periodEnd` fields describe the covered service period; `giftDurationMonths` is not rendered on each row because it is the total grant metadata repeated across monthly zero-dollar invoices. The merged gift expiry remains owned by the billing overview (`giftEndsAt`) rather than reconstructed from invoice rows. The same plan card now handles all tiers, drawn as one settings metric row: the plan name with its badges and the narrative line (interval with the switch action, or status copy) sit on the left; the one dated fact a subscriber acts on — gift expiry, next renewal, or access end after cancellation — is a labeled column on the right, mirroring the upcoming-charge summary instead of a wider display date that outshone the plan name. Free, checkout-pending, past-due and Enterprise states keep their status copy and no date column. The upcoming charge uses the ordinary settings card with the date and amount as the primary values and the backend breakdown below. The card has neither an accent border nor a colored fill.

The existing upcoming-invoice preview is also shown for `stripe_gift` when automatic billing after the gift is scheduled **and** its expected date is on or after `nextBillingAt`. An earlier preview may belong to the next zero-dollar gift invoice, so it must not be labeled as the first paid charge. The renewal line identifies the transition from gift access to the selected billing interval and includes the charged seat count. If Stripe has not produced a qualifying preview, `nextBillingAt` supplies the date but the client does not multiply current seats by list pricing: discounts, credits, tax, proration, or later seat changes may alter the total.

This extends the presentation decision in [Explain invoice reasons and defer seat collection](../feature/2026-10-12-billing-invoice-details.md). The public billing DTO is unchanged.

## Evidence and limits

Component tests cover monthly gift-period labels, scheduled gift renewal with an amount and reason, date-only fallback (including a preview for a zero-dollar gift month), and the absence of a charge claim when renewal is not scheduled. They also cover free, monthly and yearly Plus, canceled renewal and pending checkout in the shared plan card. Storybook includes the three-period history together with the post-gift charge; Playwright captures check the free, monthly, yearly, canceling, pending, and gift states. A 420px viewport has no horizontal overflow. These checks establish client behavior only; the hosted billing service still owns invoice preview accuracy and production Stripe reconciliation.
