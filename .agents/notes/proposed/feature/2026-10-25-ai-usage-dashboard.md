# AI usage: one settings page for quota, spend, and deferred turns

Status: proposed
Type: feature
Translation: current

[中文](2026-10-25-ai-usage-dashboard.zh.md)

## Abstract

The AI usage surface is currently a cloud workspace token/cost report. It cannot answer which Provider account can run right now, which machine spent the tokens, or which Sessions are waiting for a quota reset. Rate-limit state lives only in Provider rows and the composer popover; #361's deferred turns have no surface.

This proposes one page inside Settings > AI usage, not a separate dashboard or a set of tabs. It keeps Lody's settings material: a flat page, record lists as one card with ruled rows, 12/14/18px type, 0.5px edges, and no decorative color bars or glows. It also proposes local-first usage aggregation so the open-source local composition can render the page without `usageAnalytics`, plus durable rate-limit samples so the page can show how each window was consumed and reset.

The first UI slice is implemented; the rate-limit sampler and #361 data layer below are not.

## Implementation status (2026-10-25)

- Desktop Settings > AI usage keeps the existing `StatsSettingsView` (workspace header, 24h/7d/30d/all, hero tokens/cost, 3D skyline, by-model/by-member, share) and appends the new live quota, Provider/machine, history and waiting sections below it. Nothing from the old usage page is removed. Mobile keeps `MobileStatsSettings`.
- Live quota rows come from visible machines, their agent configs and the machine Flock `raceLimits` rows. The page requests one refresh for each online, query-capable Provider and exposes a manual refresh.
- The new Provider/machine table reuses the existing cloud workspace timeline, grouped into Provider series by model id. Local composition without `usageAnalytics` therefore shows live quota and the Provider/machine table without invented usage.
- `AiUsageSettingsView` carries the new quota, quota-history, Provider/machine and waiting sections; `AiUsageSettings.stories.tsx` exercises them with fixtures. The old usage page remains the upper part of the composed page.
- The first Provider/machine table drops the share bar to keep machine names readable; tokens, cost and quota remain.
- Existing usage views are preserved: the 24h/7d/30d/all range, hero tokens/cost, 3D skyline, day detail and share action stay on the existing page. The old by-model and by-member charts become one Breakdown chart with a Model/Member switch below the new sections.
- **Not wired:** machine-side `rateLimitSample` storage and #361 deferred-turn records. The history and waiting sections stay hidden until those records exist; the page does not fabricate either.
- Verification: `@lody/components` typecheck passes; `tests/ai-usage-model.test.ts` and `tests/ai-usage-view.test.tsx` pass (7 tests). The environment runs Node 26.11.1, below the repository floor, so install used `--ignore-scripts` and the ACP submodules were built manually.

## Scenario

1. **Can work continue?** Which Provider accounts are close to a limit, when do their windows reset, and which machine owns each account?
2. **Where did the spend go?** Which Provider, machine, and model produced the tokens and estimated cost?
3. **What is blocked?** Which Sessions failed on a structured quota limit, how long have they waited, and when will they retry?

The page answers those in that order. A single line at the top points to blocked Sessions; the full list sits at the bottom.

## Proposal

One page, five sections:

| Section | Content |
| --- | --- |
| 实时配额 | One row per Provider account: identity, machine, 5h/7d windows, reset times, wallet or unreported state |
| 配额历史 | 5h window over 24 hours; 7d window over 7 days, drawn from samples |
| 用量 | Tokens, cost, Providers, machines; stacked trend switchable between Provider, model and member |
| Provider 与机器 | One row per Provider/machine pair: tokens, cost, share, quota |
| 等待恢复 | #361 Sessions with elapsed time, next action, cancel, open |

Quota, attribution, and waiting are each one card with ruled rows. The KPI strip and the two chart rows sit on the page. No nested cards, no heatmap, no tabs.

### Waiting behavior

- Show **elapsed time and the next retry**, not a progress bar.
- **Cancel** is a real local control. It stops the automatic retry first and reports to the daemon; the page never waits on the server to acknowledge a cancel.
- Keep already-rendered results; a wait never clears the list.
- `waiting_for_machine` appears when the deadline passed but the owning machine is offline.
- `needs_attention` covers the daemon-death-after-submit case: no local output is not proof the Provider did nothing, so the turn is not replayed.
- The page owns no timer or scheduling authority. It reads the durable record and asks the daemon to cancel.

## Design constraints

These are deliberate, from the owner's taste review:

- One page, inside the settings surface. No separate route.
- No "正常 / 接近上限" health labels. The percentage, its colour, and the reset time carry the state.
- Provider marks keep their brand colour; no monochrome filter.
- Type sizes: 12, 14, 18 only. Minimum 12px.
- 0.5px edges and separators; no 1px borders.
- No middle-dot separators in copy.
- No redundant explanatory copy. Labels and values carry the meaning.
- Flat fills; no gradients, glows, decorative shadows, or colored left bars.
- One card per record list; no nested rounded panels.
- Concentric radii: 14px card, 8px control, 6px inner segment.
- No ambient motion. If motion is needed, ease-out around 250ms.
- Optical alignment: section headings and rows share the same left edge; numeric columns are right-aligned.

## Data and ownership

| Information | Current source | Required work |
| --- | --- | --- |
| Provider / machine identity | Agent configs, `MachineMeta`, Session `machineId` / `agentConfigId` / `modelId` | Aggregate by Provider config |
| Rate-limit windows | Machine Flock `raceLimits`, keyed by `agentConfigId + limitId`; Provider RPC refresh | Resolve scope; keep last snapshot for offline machines |
| Rate-limit history | Not stored | New `rateLimitSample` per machine, config, limit and window: sampledAt, usedPercent, resetsAt; 15-minute interval, 14-day retention, gaps when offline |
| Tokens / cost | Per-turn `tokenUsage` in Session history | Incremental local rollup; do not scan every history on page open |
| Deferred turns | Not implemented | #361 durable `deferredTurn`: Session, turn, machine, scope, deadline, state, generation |

Cost is an estimate, not an invoice. Unknown tariffs stay unknown. Usage buckets and reset times must state their time zone.

### Quota sampling (not implemented yet)

Each online machine samples Provider `rateLimits` every 15 minutes. The record is scoped to machine, agent config, limit id and window. The page reads the selected range and draws gaps where a machine was offline or a Provider no longer supports the query; it never interpolates a missing sample or extends the last value. The 5h window is drawn over 24 hours so its several resets stay readable; the 7d window is drawn over 7 days.

### Permissions

Provider account identity and quota are account-scoped. Show only machines and Providers the viewer can already see in Settings > Agents. A workspace aggregate may include member usage, but must not expose another member's Provider account or quota.

## UI contract for #361

| State | Display | Actions |
| --- | --- | --- |
| `scheduled` | "18 分钟后重试", elapsed time | Cancel, open Session |
| `waiting_for_machine` | "等待机器上线", elapsed time | Cancel, open Session |
| `dispatching` / `retrying` | "正在重试", countdown stopped | read-only |
| `needs_attention` | "需要处理", delivery unknown, not replayed | Give up, open Session |
| `canceled` / `succeeded` | Leaves the waiting list | — |

A missing machine, config, model, or mode is an actionable terminal state, never a fallback. A newer reset moves the deadline and shows "已推迟到 …", not a second entry.

## Non-goals

- Multiple tabs or a separate full-width dashboard route.
- "正常 / 接近上限" labels, or a green/amber badge that repeats what the meter already shows.
- Fake progress for quota or for a deferred turn.
- Filling sampling gaps when a machine was offline or a Provider does not report a window.
- Parsing Provider error text. Only structured reasons qualify.
- Replaying after any ACP output or tool activity.
- Drawing wallet balance as a window percentage or fabricating unreported quota.
- A second "retry now" prompt path in the waiting list.

## Open questions

1. Is the order quota → quota history → usage → attribution → waiting right, or should waiting move up?
2. Are 15-minute sampling and 14-day retention right?
3. Is the Provider × machine table enough, or do you still want a matrix?
4. Retire the 3D calendar from this page, or keep it at the bottom? The existing calendar is the three.js skyline in `usage-calendar-visualization.tsx`: one cell or bar per day, sized by tokens, opening a day detail. It is lazy-loaded and takes a lot of space.
5. Cancel + open only, or also a revalidated "retry now"?

## Evidence

- Mockup: `../../assets/ai-usage-dashboard/page.png`.
- Implemented page: `packages/components/src/components/settings/ai-usage-setting.tsx`, `ai-usage-setting-view.tsx`, `ai-usage-model.ts`.
- Story with full history and waiting fixtures: `packages/components/src/stories/AiUsageSettings.stories.tsx`.
- Composed page story (old usage page + new sections): `settings-aiusagesettings--composed`.
- Tests: `packages/components/tests/ai-usage-model.test.ts`, `tests/ai-usage-view.test.tsx`.
- Existing usage view: `packages/components/src/components/settings/stats-setting.tsx`, `stats-setting-pure.tsx`, `settings-data-cache.tsx`.
- Quota reading: `packages/components/src/lib/session-usage.ts`, `packages/shared/src/schema.ts`, `packages/shared/src/machine-flock.ts`.
- Per-turn usage: `packages/shared/src/session-data/token-usage.ts`, `apps/cli/src/lib/usage/`.
- Issue: [Lody #361](https://github.com/LodyAI/Lody/issues/361).
