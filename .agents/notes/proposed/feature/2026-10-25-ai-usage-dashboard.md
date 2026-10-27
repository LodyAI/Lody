# AI usage and Provider quota: preserve the section design across settings

Status: proposed
Type: feature
Translation: current

[中文](2026-10-25-ai-usage-dashboard.zh.md)

## Abstract

Lody needs both current provider quota and historical consumption, while preserving the owner's row and chart design. The owner now requests configuration and account-quota views inside Agents, switched by an icon button and sharing the same rows. AI Usage returns to consumption only. The [UX hierarchy decision](2026-10-26-agent-usage-ux-research.md) owns this placement. Quota history and sampling are removed; accurate account attribution and #361's waiting data remain unimplemented. This note retains the section reference and future data contracts; visual review remains proposed.

## Implementation status (2026-10-27)

- `AgentsViewToggle` switches configuration and quota with overlapping fade/blur glyphs. Configuration groups by machine; quota groups visible sources by Provider. Both reuse `ProviderRow`, configuration actions and row-level refresh.
- `ProviderQuotaWindows` shares full windows/reset times and wallet rendering between Agents and the reference view. All reported windows are directly visible, without a disclosure, history, distribution rail or configuration jump. Missing account identity does not merge configurations.
- Configuration retains machine tabs; quota uses Provider sections with a machine label per row and edits the owning machine. Switching back preserves machine selection.
- AI Usage requires `usageAnalytics` and preserves its workspace header, range, totals, activity, day detail, sharing and Model/Member breakdown. The mixed model-family Provider/machine table remains reference-only because source attribution is unverified.
- **Not wired:** #361 deferred-turn records. Quota history, sampling plans and history fixtures are removed. No scheduler or waiting authority is added.
- The default story retains the remaining section reference. Composed and AgentsPage preview the switch; AgentsQuota and LocalQuota start in quota, while Consumption previews AI Usage. Validation and limits are recorded in the [owning hierarchy note](2026-10-26-agent-usage-ux-research.md#validation-and-limits).

## Scenario

1. **Can work continue?** Which Provider accounts are close to a limit, when do their windows reset, and which machine owns each account?
2. **Where did the spend go?** Which Provider, machine, and model produced the tokens and estimated cost?
3. **What is blocked?** Which Sessions failed on a structured quota limit, how long have they waited, and when will they retry?

These questions define distinct scopes. The original full section design remains a reference story; the linked hierarchy note owns its current placement.

## Proposal

The four remaining sections below remain visual/data references. Their current production placement follows the linked hierarchy note:

| Section         | Content                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| 实时配额        | One row per Provider account: identity, machine, 5h/7d windows, reset times, wallet or unreported state |
| 用量            | Tokens, cost, Providers, machines; stacked trend switchable between Provider, model and member          |
| Provider 与机器 | One row per Provider/machine pair: tokens, cost, share, quota                                           |
| 等待恢复        | #361 Sessions with elapsed time, next action, cancel, open                                              |

Quota, attribution, and waiting were designed as cards with ruled rows. The current hierarchy reuses those visual assets; quota history is removed and full waiting controls remain a future Session concern.

### Waiting behavior

- Show **elapsed time and the next retry**, not a progress bar.
- **Cancel** is a real local control. It stops the automatic retry first and reports to the daemon; the page never waits on the server to acknowledge a cancel.
- Keep already-rendered results; a wait never clears the list.
- `waiting_for_machine` appears when the deadline passed but the owning machine is offline.
- `needs_attention` covers the daemon-death-after-submit case: no local output is not proof the Provider did nothing, so the turn is not replayed.
- The page owns no timer or scheduling authority. It reads the durable record and asks the daemon to cancel.

## Design constraints

These are deliberate, from the owner's taste review:

- Existing settings surfaces only; preserve the original section layouts. The owner-requested hierarchy preview switches two views within Agents, as recorded in the linked UX note.
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

| Information                 | Current source                                                                       | Required work                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Provider / machine identity | Agent configs, `MachineMeta`, Session `machineId` / `agentConfigId` / `modelId`      | Aggregate by Provider config                                                            |
| Rate-limit windows          | Machine Flock `raceLimits`, keyed by `agentConfigId + limitId`; Provider RPC refresh | Resolve scope; keep last snapshot for offline machines                                  |
| Tokens / cost               | Per-turn `tokenUsage` in Session history                                             | Incremental local rollup; do not scan every history on page open                        |
| Deferred turns              | Not implemented                                                                      | #361 durable `deferredTurn`: Session, turn, machine, scope, deadline, state, generation |

Cost is an estimate, not an invoice. Unknown tariffs stay unknown. Usage buckets and reset times must state their time zone.

### Permissions

Provider account identity and quota are account-scoped. Show only machines and Providers the viewer can already see in Settings > Agents. A workspace aggregate may include member usage, but must not expose another member's Provider account or quota.

## UI contract for #361

| State                      | Display                                    | Actions               |
| -------------------------- | ------------------------------------------ | --------------------- |
| `scheduled`                | "18 分钟后重试", elapsed time              | Cancel, open Session  |
| `waiting_for_machine`      | "等待机器上线", elapsed time               | Cancel, open Session  |
| `dispatching` / `retrying` | "正在重试", countdown stopped              | read-only             |
| `needs_attention`          | "需要处理", delivery unknown, not replayed | Give up, open Session |
| `canceled` / `succeeded`   | Leaves the waiting list                    | —                     |

A missing machine, config, model, or mode is an actionable terminal state, never a fallback. A newer reset moves the deadline and shows "已推迟到 …", not a second entry.

## Non-goals

- A separate full-width dashboard route.
- "正常 / 接近上限" labels, or a green/amber badge that repeats what the meter already shows.
- Fake progress for quota or for a deferred turn.
- Parsing Provider error text. Only structured reasons qualify.
- Replaying after any ACP output or tool activity.
- Drawing wallet balance as a window percentage or fabricating unreported quota.
- A second "retry now" prompt path in the waiting list.

## Open questions

1. How should deferred-turn records link back to their Sessions once #361 provides data?
2. Which recorded identities can support accurate consumption attribution beyond model/member?
3. The existing 3D calendar stays in AI Usage with its lazy loading and day detail. Further changes to its design require a separate decision.
4. Cancel + open only, or also a revalidated "retry now"?

## Evidence

- Mockup: `../../assets/ai-usage-dashboard/page.png`.
- Implemented page: `packages/components/src/components/settings/ai-usage-setting.tsx`, `ai-usage-setting-view.tsx`, `ai-usage-model.ts`.
- Story with quota and waiting fixtures: `packages/components/src/stories/AiUsageSettings.stories.tsx`.
- Original section reference: `settings-aiusagesettings--default`. AI Usage: `settings-aiusagesettings--consumption`. Agents configuration/quota switch: `settings-aiusagesettings--agents-page`; quota initially selected: `settings-aiusagesettings--agents-quota`.
- Tests: `packages/components/tests/ai-usage-model.test.ts`, `tests/ai-usage-view.test.tsx`.
- Existing usage view: `packages/components/src/components/settings/stats-setting.tsx`, `stats-setting-pure.tsx`, `settings-data-cache.tsx`.
- Quota reading: `packages/components/src/lib/session-usage.ts`, `packages/shared/src/schema.ts`, `packages/shared/src/machine-flock.ts`.
- Per-turn usage: `packages/shared/src/session-data/token-usage.ts`, `apps/cli/src/lib/usage/`.
- Issue: [Lody #361](https://github.com/LodyAI/Lody/issues/361).
