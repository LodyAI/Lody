# Remove the ended yearly early-bird campaign display

Status: implemented
Translation: current

English | [中文](2026-10-01-end-yearly-early-bird.zh.md)

## Abstract

The public pricing page continued to advertise a fixed early-bird yearly price
after the campaign ended. It now displays the standard $96 per-seat annual plan,
while workspace creation and billing screens no longer advertise early-bird
eligibility or lock-in promises. Existing account-specific prices and invoice
discounts remain visible as ordinary billing amounts. This removes campaign
presentation without changing previously earned subscription benefits.

## Decision and ownership

The pricing page owns static public list prices ($8 per month billed yearly,
$10 billed monthly), without clock or environment gates. Its campaign banner,
strike-through prices, deadline copy, and unused styles are removed in both
languages. The Chinese landing metadata no longer advertises the campaign.

Shared workspace and billing components still render server-provided prices;
invoice discounts use the generic subscription-discount label. Historical offer
identifiers remain compatible with account data. A renamed billing story retains
an eligible account, while new-workspace stories use standard pricing.

Keeping a hidden campaign switch would leave obsolete copy and an accidental
reactivation path. Removing presentation is simpler; it intentionally preserves
pricing DTO fields needed by existing accounts. This supersedes the former
presentation described in [marketing internals](../../../docs/site-landing-and-marketing.md#why-pricing-carries-no-clock).

## Verification

Targeted billing UI tests, site build, and type checks are run with the private
composition that consumes these public components. Deployment remains separate
from the source change; no live subscription is modified by this change.
