# Latest referral choice before Checkout

Status: implemented
Translation: current

[中文](2026-10-24-referral-last-touch.zh.md)

## Abstract

Someone who opens a friend's referral link after another link should be able to choose that
friend before their workspace starts Checkout. The browser now replaces its stored hint on
each valid click, and the authenticated account accepts newer valid clicks while ignoring
stale devices and retries. Checkout waits for attachment before selecting a referral.
Existing workspace claims and payment rewards remain fixed; this change does not switch
the beneficiary of an already opened Checkout.

## Decision

This partially replaces the first-touch choice in [the referral view](2026-10-14-workspace-referral-view.md)
and [telemetry note](2026-10-23-referral-analytics.md). The stored `{code, expiresAt}` format
is retained: click time is `expiresAt - 30 days`. A new syntactically valid link replaces the
hint and renews its window; unrelated redirects and reads do not. The server validates
the actual referral, excluding unknown, ineligible and self-referrals before replacing its lead.

`attachLead` accepts optional `clickedAt`. Older/equal timestamps cannot replace the
account's choice, retries cannot renew its expiry, and a dismissed hint can only be revived
by a genuinely later click. The server accepts limited future skew; device clocks therefore
provide best-effort ordering, not a trusted global clock. Old clients omit the optional
argument and cannot overwrite an active timestamped lead. Deploy the compatible server first.

The attacher caches success by user, code and click time, reacts to local capture, storage
events and focus, and ignores late completion from previous identities/hints. Paid workspace
creation and upgrades await the current hint again, closing the background-attachment race.
Local-only clients remain capability-gated. A new capture resets `analyticsCapturedAt`, so
`referral/landed` remains one app observation per stored hint, not a unique-person count or
every link click. Raw codes and URLs stay out of analytics.

## Evidence and limits

Updated behavioral cases cover last-click replacement and expiry, account-level stale replay,
dismissal, invalid timestamps, same-link renewal, cross-tab observation and the attachment
barrier before checkout. Tests, typechecks and builds were not run at the user's request;
static review and formatting do not establish runtime acceptance. No deployment, live payment
or analytics ingestion verification was performed.
