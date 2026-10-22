# Workspace referral credit in billing settings

Status: implemented
Translation: current

[中文](2026-10-14-workspace-referral-view.zh.md)

## Abstract

Workspace members need to distinguish spendable referral credit from rewards already
used or temporarily frozen. Billing settings now displays these amounts separately,
with annual early-bird progress, paginated history and an administrator's copy-link
action. The hosted billing service owns eligibility and all monetary calculations;
the browser only retains an expiring attribution hint through login. The feature
requires billing capability and a server availability flag, so local-only clients
do not acquire a dependency on hosted billing.

The annual threshold UI described below was superseded on 2026-10-18 by [uniform referral credit](2026-10-18-uniform-referral-credit.md).

## Decision and responsibilities

`packages/cloud-api` defines the overview, ledger and link contracts. Operations use
the existing `billing` platform capability, while `referralRewardsSupported` permits
the server to delay enabling the surface. The billing overview cache preserves this
flag; old cache entries default to unavailable. UI state is scoped to the workspace.

The referral UI was redesigned on 2026-10-21 as one card directly under the plan card:
the available credit with a small "Details" link, and the link to share (read-only
field, copy with in-button confirmation, a native share sheet on touch devices).
The details dialog holds the breakdown (earned, applied, on-hold and to-offset only
when non-zero), the paged history and the rules; history is read only while it is
open. Ledger deltas are named events; a dispute hold and its release are neutral
amounts, never income or loss. Copying an existing link starts inside the click and
uses the shared clipboard fallback; a failure keeps the link visible for manual copy.
Admins create the link; once it exists every member can copy or share it. Free
workspaces can refer too (2026-10-21); plans that cannot refer (Enterprise, Founder,
gifts) and have no referral activity show nothing. Copy avoids ledger mechanics.

Since 2026-10-21 available credit also pays toward the first subscription: the upgrade card
shows the deduction (capped at the regular price × seats) when no other offer applies and no
Checkout is already open; the server turns it into a one-time Checkout coupon.

The newcomer discount appears in the upgrade card and the paid create-workspace form
only when `referrals.getCheckoutOffer` says checkout would apply it, with the first
period's per-seat price. The stored code is sent to checkout only when that preview
returns `sendCode`; a workspace already bound to a referral cannot drop it, so the
notice then has no "don't use" action. The overview query reports a busy billing
account as ineligible instead of throwing, so the credit stays readable.

`referral-attribution.ts` retains the first syntactically valid link for 30 days in
browser storage (hosted landing pages write the same record before any redirect).
After sign-in, `ReferralLeadAttacher` sends it to `referrals.attachLead` so the
account keeps it across browsers, devices and the desktop app; "Don't use" also calls
`referrals.dismissLead`. Attachment success is cached by authenticated user and code
only for the component's lifetime. New launches retry against the idempotent server;
rejected, invalid and self-referral attempts do not count as success. Identity changes
cancel the previous attempt's local completion, so one user's response cannot suppress
another user's attribution. No persistent attachment marker overrides the server. Checkout passes the browser hint to the server, which may
reject it and prefers the account's lead.
Storage failures must not prevent login. Account-cache cleanup removes the hint.
No balance is calculated from this storage or from a referral URL.

Keeping an explicit monetary balance avoids representing a shared team credit as
free time for every seat. The cost is separate fields for net issuance, spending,
freezes and adjustments, rather than one apparently simple but ambiguous total.

## Verification limits

Attribution tests cover first-click retention, expiry, malformed data, unavailable
storage, account switching, rejected attempts, stale completions and the local-only
capability boundary. Storybook examples cover link creation and copy states, member access,
ineligible-with-credit, loading, the details dialog (on-hold, to-offset, empty) and the checkout notice. Local checks and stories do not establish
real payment processing, deployment or Stripe webhook delivery.

Related: [invoice details and deferred seat collection](2026-10-12-billing-invoice-details.md).
