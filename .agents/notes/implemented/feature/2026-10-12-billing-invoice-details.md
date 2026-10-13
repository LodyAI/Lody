# Explain invoice reasons and defer seat collection

Status: implemented
Translation: current

English | [中文](2026-10-12-billing-invoice-details.zh.md)

## Abstract

Unexplained invoices and immediate seat-payment flows made membership and billing status confusing. The UI now explains deferred seat charges, shows invoice reasons and details, and confirms the financial consequences of member operations. Collection and authorization remain backend-owned; local tests do not establish production Stripe behavior.

## Behavior

Invoice history shows reasons, outstanding balances, localized status and original
line details. Only an unpaid, unapplied legacy seat order can be canceled; an accrued
service charge cannot. Details keep hosted invoice links and scope mutations to the
current account, workspace and invoice.

Invitations do not charge. Membership admission immediately grants access and records
any additional capacity using daily proration. Spare current-term seats are reusable.
Monthly additions are collected with renewal; annual additions are collected at the
next monthly anniversary for service through annual expiry. Removing/leaving keeps
current-term capacity and reduces the next monthly/annual renewal. Mistaken additions
require removal and contacting Lody within three days of invoice date for a manual refund.

## Presentation

Billing UI uses the settings row grammar and nothing bespoke: an invoice is a
`CompactLinkRow` (reason; date, seat change and any non-paid status; amount) shared
by history and deleted-workspace bills. Details are a receipt dialog titled by the
reason, with charge lines, a ruled total, the amount due only when it differs, and
at most a cancel and a Stripe action. Copy states the consequence once per surface.

## Ownership and validation

The backend owns immutable charges, retained capacity, shared Stripe writer recovery,
renewal-boundary corrections and reconciliation. Invite estimates share its price and
discount calculation. Billing settings state capacity and collection timing in one
line; the refund window lives in the pricing FAQ.
Unknown prices remain unknown; future totals are omitted when discount lifetime is unclear.

Component tests cover invoice details, confirmation, stale state and errors. Backend
handler tests cover collection timing and ambiguous responses; a real disposable local
backend covers concurrent admission, voluntary leave and bulk removal. This note records
source behavior, not a production deployment. Backend rollout must register invoice.created
and invoice.finalized webhooks. Unsupported tax/tiered/item-discount pricing needs support
before expansion; historical canceled subscriptions still require separate repair.

The deferred policy has no pay-before-admission state. Its unused capability flag,
unreachable payment-required response branches and old payment-first copy were
removed; membership price preparation still returns `ready` before admission.
