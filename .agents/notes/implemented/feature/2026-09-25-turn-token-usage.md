# Per-turn token usage and cost in the turn details popover

Status: implemented
Translation: current
Date: 2026-09-25
Updated: 2026-10-17
Language: English
Other language: [中文](2026-09-25-turn-token-usage.zh.md)

## Abstract

Users could see the model and run configuration for a turn, but not how many
tokens it used or what it cost. The CLI sums the Core usage `delta` routed to each
assistant turn into `tokenUsage`, and the turn details popover shows input,
output and cache tokens. It now also shows the turn's cost when the provider or
adapter reported one. DSH reports `costUSD` for the official DeepSeek endpoint,
so this change persists that value and displays it. A cost is shown only when
every contribution has a known tariff; otherwise the stored value is `null` and
the cost-estimate row is omitted, so a partial estimate is never presented as
the turn's cost. Costs remain estimates or provider bills, not invoices.

## Decision

- **Storage.** `tokenUsage` is a primitive JSON value on the assistant history
  entry, declared as `schema.Any` like `modelInfo`. Older clients ignore it.
  - It is written through the `assistant-token-usage` history action.
  - The action adds to the stored value instead of replacing it. A reopened turn,
    or a report that arrives after the turn ended, therefore keeps summing.
  - New writes are validated by `HistoryEntryWriteSchema`.
  - `costUSD` is optional and nullable on the same value. Absent means no
    contribution reported a cost. `null` means at least one contribution had no
    known tariff; once unknown, the turn stays unknown rather than becoming a
    partial sum. This mirrors Core's `sumModelUsage` rule that unknown costs
    propagate instead of becoming `$0`.
  - A row written before cost support carries tokens but no cost. A later known
    delta keeps that turn unknown instead of pricing all its tokens from the late
    contribution.
- **Attribution (CLI).**
  - When a delta arrives, it is credited to the assistant entry that currently
    owns ACP output (`getCurrentACPUpdateTarget`).
  - Deltas for a live turn stay in memory and are written once, when the turn is
    finalized.
  - If a delta arrives after the turn ended (the finalized-turn target), it is
    added to that turn immediately.
  - A second flush after the late-target switch catches deltas that arrive
    between the two.
  - A delta without `delta.usage` contributes nothing. A delta with tokens but no
    finite non-negative `costUSD` contributes an unknown cost, not a missing one.
- **Display.** Output includes reasoning, and cache is reads plus writes. Token
  values are formatted with `formatCompactNumber` in the product language, so
  units are K/M in English and 万/亿 in Chinese. The cost estimate is the last row
  of the same token section and appears only when `costUSD` is a number; it uses
  `formatUsdAmount` with extra fraction digits for sub-cent amounts and a hover
  hint that the figure is an estimate, not an invoice. Token usage on its own, including a cost-only record, is enough to
  show the info button.

## Where the DSH cost comes from

DSH's `src/usage.ts` prices each `assistant/message` at its completion time from
the official DeepSeek list rates, applying the published UTC weekday peak/off-peak
multiplier, and only when the route is the official endpoint
(`!baseUrl || isDeepSeekOfficialBaseUrl(baseUrl)`) and the model has a tariff.
Core's `SessionUsageAccumulator` includes `costUSD` in `delta.usage` only when
every model row in the delta has one. The host therefore does not invent or
recompute a price in the renderer.

## Alternatives

- **Derive from cumulative `modelUsage`.** This needs a baseline for every scope,
  and the baseline is lost across restarts. Rejected.
- **Write every delta immediately.** This makes one history write per model
  response. Rejected in favour of one write per turn plus writes for late reports.
- **Nest the value under `modelInfo._meta`.** That would hide display data inside
  provider metadata. Rejected.
- **Recompute cost in the UI from tokens and a local tariff table.** That
  duplicates pricing in a second package, cannot reproduce DSH's request-time
  peak/off-peak choice, and would price custom endpoints that deliberately have
  no known tariff. Rejected.
- **Show the known part when some models are unknown.** A smaller number presented
  as the turn total is worse than no number. Rejected.

## Limits

- Usage is attributed by arrival time. A background result that arrives during a
  later turn is credited to that later turn.
- Pending deltas are held in process memory. They are lost if the CLI exits
  before the turn is finalized.
- Cost is per assistant turn, not a session total. The workspace usage surface
  remains the place for aggregate spend.
- A custom DeepSeek endpoint, an unknown model, or a missing timestamp produces no
  DSH cost. DSH's dated list-price estimate is not an invoice, and requests that
  cross a pricing boundary may differ from billing.
- Per-turn cost comes only from the usage delta. The CLI's legacy list-price table
  used when persisting Codex/Kimi aggregate usage is not applied to the turn
  record, so those turns show tokens without a cost unless their adapter reports
  one.
- Consumers that predate the field ignore `costUSD` and keep showing tokens.

## Verification

- shared `session-history-actions`: summing across finish and late reports,
  known-cost addition, unknown-cost propagation, rejection of negative costs and
  malformed values, and ignoring user turns.
- CLI `turn-token-usage`: delta cost mapping, unknown tariff, zero-token and
  no-delta updates, and ledger accumulation.
- components `agent-activity-row`: compact values, exact values on hover, the
  cost row and its estimate hint, and a popover shown when token usage is the only
  content. The `TurnTokenUsagePopover` story carries the cost-estimate row.
- Limits of this change: the environment used for the edit had no installed
  workspace dependencies, so type, unit and format checks were not executed here;
  the added tests and Storybook state remain to be run by CI or a local install.
