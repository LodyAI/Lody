# Agent usage UX: compare entry points before choosing a new page

Status: proposed
Type: feature
Translation: current

[中文](2026-10-26-agent-usage-ux-research.zh.md)

## Abstract

A separate quota overview below machine-bound configuration creates repeated identities and conflicting scopes. Public product research distinguishes configuration, current provider capacity and historical consumption. The owner now requests two views inside Agents, switched by one icon button: configuration and account quota reuse Provider row components and actions. Configuration uses machine tabs; quota groups all visible machines by Provider and names the machine on each row. AI Usage returns to capability-gated consumption only. The owner clarified that switching must change the grouping to Provider; source rows remain distinct because account identity is unverified. Visual review is pending, and quota history, disclosure panels and the distribution rail remain removed.

## Evidence checked on 2026-10-26

| Product and primary source                                                                                                                                 | Documented behavior                                                                                                                                                                                                                     | Relevance and limits                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Conductor 0.75.0](https://www.conductor.build/changelog/0.75.0-polish) and [harness reference](https://www.conductor.build/docs/reference/harnesses)      | Hovering a Codex chat's context ring reveals account limits/resets, session tokens, plan and authentication details. Harness settings configure credentials/models; the provider owns model billing.                                    | Strong reference for a workspace orchestrator. The documented quota interaction is Codex-specific; do not claim equivalent coverage for every harness.         |
| [Claude Code commands](https://support.claude.com/en/articles/14553413-claude-code-cheatsheet)                                                             | `/usage` shows plan limits/rate-limit status; `/cost` shows session usage/spend; `/context` concerns context occupancy; `/config` opens settings.                                                                                       | Distinct commands expose different scopes. This is a CLI interaction, not evidence for a desktop navigation layout.                                            |
| [Zed Agent Panel](https://zed.dev/docs/ai/agent-panel#token-usage-and-compaction) and [billing](https://zed.dev/docs/account/billing)                      | Active-thread tokens appear near the profile selector in the message editor. Hosted billing and invoices use an account dashboard. External-agent feature support varies.                                                               | Thread/context tokens are not remaining subscription quota. Zed also explicitly distinguishes a model from the provider supplying it.                          |
| [Cline provider](https://docs.cline.bot/getting-started/cline-provider) and [authorization](https://docs.cline.bot/getting-started/authorizing-with-cline) | Provider selection/authentication live in settings. Cline credits and View Usage are account-oriented; billing organization selection determines the account charged.                                                                   | Cline's own billing pool is not a direct equivalent of aggregating unrelated third-party subscriptions.                                                        |
| [CodexBar README](https://github.com/steipete/CodexBar) and [UI contract](https://github.com/steipete/CodexBar/blob/main/docs/ui.md)                       | Menu cards expose quota windows/reset times. Overview provides provider/account comparison and detail navigation. Settings > Providers manages sources; Usage & Spend contains historical estimates, account/source context and trends. | Strong monitoring reference, but monitoring is the product's main job. Its Overview does not prove that an orchestrator needs an additional settings category. |
| [OpenCode CLI](https://opencode.ai/docs/cli/#stats)                                                                                                        | `stats` reports session token/cost history with day, model and project filters; authentication has a separate command path.                                                                                                             | Supports the distinction between credentials and retrospective consumption; no desktop quota placement is inferred from CLI documentation.                     |

These are official public documentation, release notes and maintained source documentation. No signed-in native competitor app was operated. A published screenshot is visual evidence for that release, not proof that every current build or provider has the same interface. The OpenAI documentation checked during discovery redirected to shared ChatGPT Desktop references; it is not used to assert an unverified current standalone Codex navigation path.

## Responsibilities and scope

| Surface                | Question and scope                                                    | Content                                                                                                      |
| ---------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Agents / Configuration | Configure Providers on the selected machine                           | Existing identities, configuration facts, compact quota, edit/menu and direct forecast actions               |
| Agents / Account quota | Inspect current limits across visible machines, grouped by Provider   | Shared row components and actions, with machine identity, full windows/reset times, balance or unknown state |
| AI Usage               | Review recorded workspace consumption for a selected reporting period | Existing totals, activity/calendar, day detail, Model/Member breakdown and sharing                           |
| Conversation           | Check the selected config/model during work                           | Existing `SessionUsagePopover`; a new comparison shortcut remains deferred                                   |

Quota is provider-reported and may include activity outside Lody or this workspace.
Consumption is workspace-recorded activity. The two cannot be reconciled by model
family or turned into a global remaining percentage. Configurations are never
merged into one account merely because names, plans or brands match.

## Shared-row implementation

Configuration uses `MachineProvidersSection`; account quota uses
`AgentsProviderQuotaView` over all visible machines/configs. Both render the same
`ProviderRow` implementation and retain edit, menu, binary progress and direct
forecast controls. The quota view changes the grouping and usage slot, adds the
owning machine to each row, and shares `ProviderQuotaWindows` with the reference
view. Existing row-level capability/online-gated refresh and cached readings
remain authoritative; no second quota refresh owner is introduced.

Switching replaces machine tabs with Provider sections; switching back preserves
the selected machine. Provider identity uses runtime/catalog identity and resolved
brands rather than the consumption model-family `other` bucket. A cross-machine
edit resolves the row's own machine. Missing visible machines exclude their
configurations. Grouping does not deduplicate accounts or combine percentages.
Unknown/offline sources retain cached/unknown meanings. All reported windows are
directly visible, with no disclosure, history or distribution rail.

AI Usage has no quota tabs and requires `usageAnalytics` again. Removing the former
`UsageOverview` and `AgentQuotaSettings` hosts prevents duplicate inventories and
keeps local Agents independent of cloud consumption hooks. The old mixed
Provider/machine consumption table and waiting fixtures remain reference-only;
accurate source attribution and Session waiting data are still unwired.

## Icon motion

The header uses the existing UI icon button and tooltip. Gauge and list glyphs
share one fixed cell, crossfading simultaneously with blur. Enters and exits use
named local tween constants following the Fluid Functionalism icon-swap pattern;
blur requires a tween. Reduced motion disables blur and keeps the fade. The button
has a stable accessible name and pressed state; changing the view does not gate
readiness on an animation or add a content slide/layout animation.

## Validation and limits

Rendered Provider tests exercise switching the same identity between compact and
full quota, retaining edit behavior, plan, unknown reset state and direct forecast
actions. Existing model, usage and machine-detail suites cover surrounding behavior.
Rendered grouping coverage includes multiple machines, distinct provider brands,
invisible sources and editing on the owning machine. Typecheck, scoped lint,
translation and platform/public-boundary checks are run;
pre-existing documentation errors are compared against the initial status. Browser
review covers both views, the machine-to-Provider grouping switch, narrow/wide rows, icon motion
and reduced motion in synthetic stories. The installed Electron app is not exercised.
The environment's Node 26.11.1 is below the repository floor and missing ACP workspace
packages prevent a clean public-boundary check; full repository validation is not claimed.
