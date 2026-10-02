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
- `paid` stops polling but deliberately keeps the activation banner until the overview flips, so the
  plan never flashes back to Free between the reconcile write and the subscription read.
- The offer card and the free session/member limits are hidden while `paymentProcessing` is true;
  the plan name renders Plus with the existing "Payment received" banner. A `canceled` or unknown
  return marker clears the stored intent; only a missing marker falls back to it, so a canceled
  checkout cannot borrow a stale success intent.
- `reconcileWorkspaceCheckout` is held in a ref: `useCloudAction` may return a new function identity
  per render, and the previous one-shot effect could restart without that stability.

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
