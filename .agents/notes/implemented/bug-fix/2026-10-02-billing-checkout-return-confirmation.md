# Keep web checkout confirmation alive until the entitlement lands

Status: implemented
Translation: current
PR: [#1218](https://github.com/LodyAI/Lody/pull/1218)

[中文](2026-10-02-billing-checkout-return-confirmation.zh.md)

## Abstract

Returning from a successful web Stripe Checkout could show the workspace as Free even though
payment succeeded: the billing page read the one-shot `?checkout=success` marker, stripped it, and
called `reconcileWorkspaceCheckout` exactly once. A single transient miss (the Stripe session or the
server's pending record not linked yet) ended the activation state and fell back to the cached
pre-checkout overview. The confirmation now keeps a per-tab intent, polls the idempotent reconcile
inside a bounded window, and renders the activating Plus plan until the reactive entitlement lands.
This is not a live-Stripe acceptance; it removes the client-side single-shot race and relies on the
existing server reconcile contract.

## Decision and scope

- The `?checkout=success` query marker remains a trigger, not durable state. On success the page
  records `lody:billing-checkout-return:<workspaceId>` in `sessionStorage`, so a reload, route
  remount, or desktop deep-link hand-off can still confirm the same checkout.
- A transient miss (`status: 'none'`) no longer clears the activation state. The loop retries every
  3 seconds and stops on `paid`, `expired`, the reactive `isBillingActivationSettled` condition, or
  after a two-minute window. A timeout clears the banner rather than pinning an abandoned checkout
  forever; the reactive query still flips if a later webhook arrives.
- `paid` stops polling but keeps the return marker and activation banner until the live overview flips, so the
  plan never flashes back to Free between the reconcile write and the subscription read.
- The offer card and the free session/member limits are hidden while `paymentProcessing` is true;
  the plan name renders Plus with the existing "Payment received" banner. A `canceled` or unknown
  return marker clears the stored intent; only a missing marker falls back to it, so a canceled
  checkout cannot borrow a stale success intent.
- `reconcileWorkspaceCheckout` is held in a ref: `useCloudAction` may return a new function identity
  per render, and the previous one-shot effect could restart without that stability.

## Review correction (2026-10-03)

The first implementation also polled ordinary unpaid checkouts and treated the pre-checkout Plus
cache as completion. This hid “Continue checkout” for unpaid workspaces and stopped gift renewal
confirmation before the live query loaded. Pending checkout/setup flags now trigger a single
background check; only a successful return or a server `paid` result activates confirmation. Opening
Checkout no longer writes a success marker. The redundant `reconciling` state, one-shot start latch,
and cached-overview ref were removed; effect dependencies and cleanup own the polling lifetime.

Settlement uses the live query, requires both pending flags to clear, and requires
`autoRenewAfterGift` for `stripe_gift` entitlement. A paid response retains the marker until that
settlement, so remounting during query lag does not lose confirmation. The existing desktop external
poll remains separate. These are corrections to the intended confirmation behavior, not a new
billing or server contract.

## Alternatives considered

- **Pass a callback marker in `successUrl`/`cancelUrl` from the client.** The server owns the
  desktop/web return URLs and may already append the marker; duplicating it blindly risks a
  malformed or duplicated query. The client-side intent works regardless of which side appends it.
- **Keep one reconcile but stop clearing on `none`.** Without retry or a deadline this can leave an
  abandoned checkout parked on the activation banner; the bounded loop is the missing half.
- **Wait for the webhook only.** That is the failure the reconcile fallback exists to cover; the
  reported symptom is exactly a page that trusted it too early.

## Evidence and limits

Deterministic tests cover the persisted marker lifetime, the settlement predicate, the activating
Plus rendering, the container flow where the first reconcile returns `none` and the retry lands
`paid`, and the canceled return that must clear a stored intent without reconciling. Component
typecheck, Oxlint, the full `@lody/components` suite (553 files), and Oxfmt pass; broader checks are
recorded in the change handoff. No live Stripe test was run, so the exact timing of a real webhook
versus a real `checkout.session.completed` remains unmeasured, and the two-minute window is a product
choice rather than a Stripe guarantee. Desktop external checkout keeps its existing, longer polling
loop.

The review regression suite additionally covers an unresolved/pending unpaid check and remount,
stale cached and live gift Plus state followed by setup and automatic renewal, paid confirmation
across remount, and expiry, timeout, and transient action failures. Tests use injected platform
responses and fake timers. Both reported paths fail against the pre-fix implementation; all 43 tests
in the seven related suites pass with the fix. Component typecheck, Oxfmt, and documentation checks
pass; targeted type-aware Oxlint reports no errors (24 warnings). Before pushing, root `pnpm format` passed and `pnpm check` passed typecheck and lint, then stopped
on the unrelated CLI `workspace-git-service.test.ts:76` assertion: the local project lacked the
expected `githubRepoFullName`. CLI results were 3,453 passed, one failed, and four skipped; the
remaining full-suite checks did not complete. Live Stripe acceptance was not run.
