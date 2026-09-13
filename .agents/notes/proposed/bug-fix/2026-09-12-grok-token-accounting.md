# Grok and DSH usage accounting

Status: proposed
Translation: current

[中文](2026-09-12-grok-token-accounting.zh.md)

Previous PR (closed, superseded): https://github.com/LodyAI/Lody/pull/661

Current PR: https://github.com/LodyAI/Lody/pull/662

Dependencies: [Core #9](https://github.com/LodyAI/acp-extension-core/pull/9),
[Grok #16](https://github.com/LodyAI/acp-extension-grok/pull/16),
[DSH #16](https://github.com/LodyAI/acp-extension-dsh/pull/16).

## Abstract

Grok supplied per-prompt model totals where consumers require cumulative model
snapshots. Preserving every prompt in a delivery queue did not repair this semantic
mismatch, so the previous PR was closed. The replacement adds optional already-included
deltas to Core, accumulates Grok prompt contributions, and integrates DSH request
usage with official DeepSeek list-price estimates. Synthetic tests verify the
boundaries; deployment, restart continuity and unreported background usage remain limits.

## Correction to the initial investigation

The original synthetic reproducer correctly demonstrated client snapshot replacement
and failure loss, but incorrectly treated ordered prompt delivery as a sufficient
accounting repair. A consumer expecting cumulative model counters needs adapter
normalization even if every prompt is delivered. The old queue-only reproducer is
removed; owning behavioral tests now cover the corrected contract.

Claude's top-level latest-turn usage and cumulative modelUsage are intentionally
different scopes; that difference alone is not a bug. Codex reads tokenUsage.total;
Kimi's inspected activation accumulator also preserves successive contributions.
This change does not migrate those adapters or infer that all their reset/bucket
semantics are correct. Private implementation details are not copied into this note.

## Contract and implementation

Core 0.1.5 adds optional delta { usage, modelUsage }; cumulative modelUsage already
contains it. Consumers coalesce snapshots rather than add notifications. The shared
accumulator retains operation IDs/counters, merges late corrections monotonically,
and preserves unknown costs. Replays and caller mutation cannot inflate totals.
No transcript or user content is retained.

Grok's two completion channels share the native prompt ID. The accumulator accepts
late per-model completeness corrections, skips replay, and keeps prompt usage in
the top-level snapshot. Reports lacking IDs or model attribution are not guessed.
The inclusive-to-disjoint cache/reasoning conversion and ticks / 10^10 remain.
The inspected official [Grok ledger](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-chat-state/src/usage.rs)
supports whole-prompt totals; exact source mapping to locked 1.0.13 remains unproven.

Pinned @deepseek-ai/dsh-session and dsh-llm-deepseek 0.1.1-rc.2 package declarations/
implementation establish assistant/message.data.usage per request, event seq and
epoch-millisecond time, and request/context model attribution. DeepSeek's mapping
already subtracts cached input, but leaves reasoning included in completion output.
The adapter counts committed messages, not raw usage chunks, including multiple steps.

Official [pricing](https://api-docs.deepseek.com/quick_start/pricing/) was read
directly on 2026-09-13: search indexes were stale. Flash is now V4.1, including old
V4 Flash/vision aliases. DSH prices each request using its completion timestamp
and the UTC weekday schedule, then accumulates USD; unknown/custom routes stay unknown.
This differs from repricing a whole session at flush time and avoids changing
historical request estimates when a later turn crosses a pricing boundary.

## Alternatives and limits

- Rejected: queue per-prompt deltas into a cumulative consumer; still undercounts.
- Rejected: provider-specific accumulation in Lody; native semantics belong in adapters.
- Retained: process-local acknowledged delivery/retry and legacy Codex compaction.
- Chosen: a shared accumulator and additive optional delta, preserving legacy wire
  compatibility. It retains accounting IDs for the active lifetime, not a durable ledger.
- DSH covers reported ACP-owned session events, not unreported internal/subagent
  requests. A request spanning a rate boundary is estimated at completion, not invoiced.
- No raw user sample, authenticated runtime call, private-source publication, or
  production deployment was used. Existing historical undercounts are not repaired.

## Verification and rollout

Core accounting tests, Grok real proxy tests, DSH ACP boundary and accounting tests,
and CLI delivery tests use synthetic fixtures and injected event times/signals.
Core 2, Grok 58, DSH 15, CLI delivery 8 and parser 12 tests pass. Core build/typecheck,
DSH build/format check, Grok build/syntax check, docs check and both public/platform
boundary guards pass. CLI suites were bundled with real narrow shared exports in
an isolated dependency harness. Root check stops in Claude's missing dependencies;
root format stops at a package without Prettier. No complete root check is claimed.
Core 0.1.5 must publish before Grok/DSH consuming its helper; then release/rebuild
adapters and update consumer artifacts/gitlinks. No new PR or release is created
by the implementation itself. Follow-up and dependency PRs are linked above.
No packages are published.

[Current delivery Spec](../../../../specs/usage-delivery.md)
