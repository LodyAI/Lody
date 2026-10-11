# Provider quota overview and reset forecasts

Status: draft
Translation: current

[中文](provider-quota-overview.zh.md)

A person scanning configured Providers needs to identify the Provider and judge its remaining subscription quota. A third-party reset probability is different information: a 65% chance of a reset must not read as another remaining-quota percentage beside 5h and 7d windows.

## Row structure

A Provider row presents identity and model/usage metadata, read-only remaining quota, a flat “Reset forecast” action when eligible, and a persistent named Provider management menu. All reported windows retain their names and percentages. Quota wraps below the identity in narrow panels; additional windows wrap without hiding data behind a count or an intermediate details popover.

The quota group explicitly labels percentages as remaining quota. Refresh models/modes and delete belong to the Provider menu; deletion retains confirmation. Clicking the identity area still opens Provider configuration. Hover must not move or cover controls or reserve empty hidden-action slots.

## Direct forecast action

“Reset forecast” opens the existing forecast dialog in one step. There is no quota-details button or interstitial repeating information already visible in the row. The action carries no probability or cached percentage in its label. The dialog explains the third-party source, probability, or announced schedule using the existing forecast semantics.

Eligible first-party Codex Providers keep the action even without reported quota or an active forecast. No quota is fabricated when usage is unavailable. Listing Providers makes no forecast request; selecting the action revalidates the shared store. Closing the dialog returns keyboard focus to the direct action. Composer forecast behavior is unchanged.

## Evidence

- [Provider row](../packages/components/src/components/settings/provider-row.tsx)
- [Read-only quota and direct forecast action](../packages/components/src/components/settings/provider-usage-summary.tsx)
- [Browser behavior](../packages/components/tests/e2e/desktop-settings-layout.spec.ts)
- [Provider tests](../packages/components/tests/provider-row-reauthentication.test.tsx)
- [Decision](../.agents/notes/implemented/bug-fix/2026-10-10-codex-reset-provider-actions.md)
