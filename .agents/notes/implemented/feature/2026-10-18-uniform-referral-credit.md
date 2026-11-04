# One referral balance view for every eligible plan

Status: implemented
Translation: current

[中文](2026-10-18-uniform-referral-credit.zh.md)

## Abstract

Early-bird subscribers now earn the same referral reward as standard subscribers, so
an annual discount threshold no longer describes their available credit. The referral
view and client contract remove threshold progress and use the same balance fields
for every eligible workspace. Existing early-bird pricing is independent of referral
credit. This change updates local source; it does not establish a hosted rollout.

## Decision and validation

This supersedes the annual early-bird progress portion of the
[original referral view](2026-10-14-workspace-referral-view.md). The server remains the
authority for monetary amounts; the client does not derive a threshold from seat count
or plan pricing. Copy states that existing early-bird subscribers earn the same 20%.
The overview contract no longer exposes the unused annual threshold object, and the
threshold-specific story and translation keys are removed. Available, issued, spent,
frozen and adjustment balances and paginated history remain separate.

Client type checks validate the changed contract and view. Translation and documentation
checks cover the revised copy and links; these checks do not verify hosted payment flows.
