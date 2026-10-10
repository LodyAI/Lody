# Provider quota details

Status: draft
Translation: current

[中文](provider-quota-details.zh.md)

A person scanning configured Providers needs to identify the Provider and judge its remaining subscription quota. A third-party reset probability is a different kind of information: a 65% chance of a reset must not read as another remaining-quota percentage beside the 5h and 7d windows.

## Overview and actions

A Provider row presents identity and model/usage metadata, a read-only remaining-quota summary, an explicitly labeled “Quota details” button, and a persistent Provider management menu. The summary shows at most two reported windows and the number of additional windows; details retain every window and its provider-supplied name. The summary remains visible at rest and on hover. When the panel is narrow, quota moves below the identity rather than covering it. Hover must not move controls, reveal an overlay over them, or reserve empty slots for hidden actions.

The summary explicitly labels percentages as remaining quota. Refresh models/modes and delete belong to the named Provider's menu; deletion retains its confirmation. Provider configuration remains accessible through its identity area.

## Quota and forecast details

Selecting the “Quota details” button opens details for that exact Provider configuration. Those details show remaining percentages for its reported windows. Eligible first-party Codex Providers keep a quota-details entry even when the Provider has not reported usage, and that empty state says so.

The third-party reset forecast entry is inside quota details, separated from reported quota and attributed to codex-resets.com. It carries no probability in the overview or its entry button. The forecast dialog explains probability or an announced schedule using the existing forecast semantics.

Listing Providers and opening quota details make no forecast request. Only selecting the forecast entry revalidates the shared forecast store. The forecast dialog survives dismissal of the quota popover. Composer usage behavior is unchanged.

## Evidence

- [Provider row](../packages/components/src/components/settings/provider-row.tsx)
- [Quota summary and details](../packages/components/src/components/settings/provider-usage-details.tsx)
- [Browser behavior](../packages/components/tests/e2e/desktop-settings-layout.spec.ts)
- [Provider tests](../packages/components/tests/provider-row-reauthentication.test.tsx)
- [Decision](../.agents/notes/implemented/bug-fix/2026-10-10-codex-reset-provider-actions.md)
