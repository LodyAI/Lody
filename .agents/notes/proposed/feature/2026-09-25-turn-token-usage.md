# Per-turn token usage in the turn details popover

Status: proposed
Translation: current

[中文](2026-09-25-turn-token-usage.zh.md)

## Abstract

Users could see the model and run configuration for a turn, but not how many
tokens it used. The CLI now sums the Core usage `delta` reports routed to each
assistant turn into a new `tokenUsage` field on the history entry. The turn
details popover shows input, output and cache tokens in compact units, with
exact values on hover. Deltas are used because the adapters can compute them
without double counting after a resume (see
[usage scopes](../bug-fix/2026-09-25-usage-accounting-scopes.md)). Cumulative
totals would need per-scope baselines and are not used. Turns from adapters
that send no `delta` show nothing rather than an estimate.

## Decision

- **Storage.** `tokenUsage` is a primitive JSON value on the assistant history
  entry, declared as `schema.Any` like `modelInfo`. Older clients ignore it.
  - It is written through a new `assistant-token-usage` history action.
  - The action adds to the stored value instead of replacing it. A reopened turn,
    or a report that arrives after the turn ended, therefore keeps summing.
  - New writes are validated by `HistoryEntryWriteSchema`.
- **Attribution (CLI).**
  - When a delta arrives, it is credited to the assistant entry that currently
    owns ACP output (`getCurrentACPUpdateTarget`).
  - Deltas for a live turn stay in memory and are written once, when the turn is
    finalized.
  - If a delta arrives after the turn ended (the finalized-turn target), it is
    added to that turn immediately.
  - A second flush after the late-target switch catches deltas that arrive
    between the two.
- **Display.** Output includes reasoning, and cache is reads plus writes. Values
  are formatted with `formatCompactNumber` in the product language, so units are
  K/M in English and 万/亿 in Chinese. Token usage on its own is enough to show
  the info button.

## Alternatives

- **Derive from cumulative `modelUsage`.** This needs a baseline for every scope,
  and the baseline is lost across restarts. Rejected.
- **Write every delta immediately.** This makes one history write per model
  response. Rejected in favour of one write per turn plus writes for late reports.
- **Nest the value under `modelInfo._meta`.** That would hide display data inside
  provider metadata. Rejected.

## Limits

- Usage is attributed by arrival time. A background result that arrives during a
  later turn is credited to that later turn.
- Pending deltas are held in process memory. They are lost if the CLI exits
  before the turn is finalized.
- Cost is not shown. Unknown costs would need separate display semantics.

## Verification

- shared `session-history-actions`: summing across finish and late reports,
  rejection of malformed values, and ignoring user turns.
- CLI `message-handler-acp-batching`: the real MessageHandler with the Loro doc,
  delta-only attribution, late reports, and two turns kept separate.
- components `agent-activity-row`: compact values, exact values on hover, and a
  popover shown when token usage is the only content.
