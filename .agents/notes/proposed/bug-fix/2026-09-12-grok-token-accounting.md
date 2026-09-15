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

## Builtin audit correction (2026-09-13)

This audit matrix describes baseline e2b55096; the follow-up below supersedes the
items it explicitly fixes, not the remaining lifetime/coverage limitations.

Adapter tests alone did not establish end-to-end delivery. The CLI accepted only
managed runtimes, excluding builtin `deepseek`. The receiver now uses the builtin
catalog and the service accepts `BuiltinAgentType`, without adding DSH to managed
downloads or enabling cloud services in local composition.

| Provider | Inspected scope / delta                                                                     | Remaining mismatch                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Grok     | Current branch accumulates prompt/model contributions and emits delta                       | Fresh processes lose the baseline; same-ID resume needs continuity. Exact locked-runtime source mapping remains unproven.        |
| DeepSeek | Current branch accumulates committed requests and emits delta; new sessions get fresh IDs   | Receiver exclusion fixed here; unreported internal requests remain outside coverage.                                             |
| Claude   | Query-wide model totals include subagents; no delta emitted                                 | Resume creates a new query with the same session ID; clear/reset also resets SDK counters.                                       |
| Kimi     | Locked f255222661c9 accumulates per-model/subagent usage since activation; no delta emitted | Resume keeps the session ID but establishes a new usage baseline. A submodule edit does not update the managed artifact.         |
| Codex    | Locked 0.153.4 thread totals; no modelUsage or delta emitted                                | Inclusive buckets violate Core; current-model fallback misattributes old usage; reset offsets do not survive successful flushes. |

The pinned [Codex decoder](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/codex-api/src/sse/responses.rs)
keeps cached/cache-write tokens inside input and reasoning inside output. Its synthetic
100 input / 10 output example includes 40 cached, 60 cache-write and 5 reasoning.
Executing the current adapter mapping yields an independent-bucket sum of 155, not
110, and omits cache creation. Correct disjoint buckets are 0 input + 40 read + 60
write + 5 output + 5 reasoning. The [native protocol](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/protocol/src/protocol.rs)
also resets counters on context-window fill; `last` is not an exactly-once delta.
Claude's [SDK contract](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
distinguishes latest-turn main-agent usage from query-wide model totals and resets.

Synthetic execution of actual extracted receiver/adapter methods and the locally
inspected consumer reducer (no private source published) establishes: DeepSeek was
dropped, while the repaired receiver accepts all five and excludes custom/unknown
providers; model A=100 followed by model B=thread-total 200 produces 300; same-key
1000 then a fresh lifetime's 200 produces no increment. The actual Codex delivery
service also loses its offset across acknowledged 1000 / 0 / 200 flushes. These are
code-level reproductions, not customer observations or authenticated runtime runs;
the reset fixture establishes consumer behavior, not reset frequency.

The parser preserves optional delta for all five providers; legacy persistence
still receives only snapshots. This follow-up does not add Claude/Kimi/Codex delta
producers: Kimi already has native differences; Claude needs a known query baseline;
Codex needs normalization and reliable model/lifetime attribution. Never invent
delta costs or treat top-level usage as a complete delta by default.

Next decision: explicit accounting-lifetime identity through Core and the consumer,
or durable cumulative baseline restoration. Random per-notification identities and
blindly adding replayable deltas are not substitutes. No lifecycle repair or complete
provider conformance is claimed. The receiver repair passes 13 delivery and 16 parser
tests in the isolated harness. The required `context/message-flow.md` instruction
target is absent here; the receiver edit is limited to provider eligibility.

## Review follow-up: scoped repairs

2026-09-15 endpoint-field correction: legacy persistence rejects aggregate
webSearchRequests and model-level contextWindow. Project token/cost fields at the
delivery boundary, keeping contextWindow only at aggregate scope. Search counts
are intentionally omitted at both scopes per product direction; Core remains
unchanged. A strict synthetic transport field validator exposed three failures
before the fix (including both legacy compaction tests); all 16 delivery tests
pass after projection, preserving all token buckets and known/unknown cost.

### Delivery ablation (2026-09-15)

The real delivery service ran in the existing isolated test harness (only transport
stubbed). Strengthened two existing tests first: mutate the actually staged input,
and flush a missing model map before replacing it. Baseline: 15/15 pass.

| Ablation                                                                 | Observable result                              | Decision                                                          |
| ------------------------------------------------------------------------ | ---------------------------------------------- | ----------------------------------------------------------------- |
| Remove internal snapshot re-cloning and redundant staged null check      | 15/15 pass                                     | Keep removal: entry owns a copy; merge helpers return new objects |
| Replace the at-most-one-element delivery array with one nullable payload | 15/15 pass                                     | Keep: newer updates remain coalesced separately                   |
| Remove entry ownership copy                                              | 1 failure: caller changes delivered 200 to 999 | Restore                                                           |
| Remove shared in-flight drain guard                                      | 1 failure: deliveries become 100, 100, 200     | Restore                                                           |

Experiments were sequential, reverting rejected candidates before the next.
No provider source, pricing, lifetime or persistence contract changes. Passing
synthetic tests establishes these covered behaviors, not production end-to-end
verification; full workspace checks remain dependency-limited.

2026-09-14 integration correction: Lody main `6de01729` already includes #664,
which migrates the DSH launcher to profile files, the `dsh` command, and explicit
per-package version specifiers. The earlier launcher incompatibility applies to
the pre-merge branch, not this integrated tree. Merge DSH `ee8570f`, retaining
durable usage handling alongside transient assistant streaming and untracking all
generated `dist` files. DSH build, 19 tests, and format check pass. Codex native
compaction fixes are retained alongside usage accounting; its build and 19
usage/transport tests pass, while 112 ACP tests fail setup because the isolated
dependencies lack the Codex executable. Root checks still lack workspace dependencies.
Official Harness 0.1.5-rc.2 source retains the normal completed-request usage
shape and cache/reasoning bucket semantics; this is not an authenticated E2E claim.

Dependency review PRs: [Codex #42](https://github.com/LodyAI/acp-extension-codex/pull/42),
[Claude #26](https://github.com/LodyAI/acp-extension-claude/pull/26), and
[Kimi #10](https://github.com/LodyAI/acp-extension-kimi/pull/10). Core #9 and DSH #16
are updated in place; the consuming PR remains Lody #662.

- DSH now prices the real registered `deepseek-official` route. ACP-boundary
  tests exercise official and custom endpoints with identical usage and verify
  that only the official route receives USD. Earlier tests used the wrong route.
- Codex normalizes inclusive input/output and keeps cache creation. Native thread
  events do not identify per-model contributions, so `codex:unattributed` is an
  explicit unknown-attribution bucket, not a fabricated model or a pricing key.
  Session-owned accounting retains offsets across native context-window fill
  sentinels and prompt handlers, emits already-included delta, and preserves the
  legacy top-level cumulative scope. This is not durable restart restoration.
- Claude splits available thinking tokens, propagates unknown-price history,
  reports billed cancelled results, and differences query-wide model totals for
  delta (including subagents). A decreasing counter omits delta; it does not
  guess a fresh lifetime. Unrecorded thinking detail cannot be reconstructed.
- Kimi derives delta from the last successfully emitted activation snapshot.
  A required read-only review found swallowed send failures and overlapping
  emissions; these were repaired with serialized emission and success-only
  baseline advancement. Source changes still require a new managed artifact;
  the existing locked artifact is not changed or claimed to contain this work.
- CLI retains legacy Codex offsets after acknowledgement, bypasses that path for
  adapter-owned cumulative updates with delta, and preserves unknown costs and
  provider estimates. Without a cache-write tariff it omits a legacy estimate
  rather than charging the cache-read tariff. Empty Core aggregates have no cost.

Synthetic verification: Core 3, DSH 16, Codex usage 9, Claude usage 10, Kimi
projection 7, and CLI delivery 15 tests pass in isolated dependency harnesses.
Actual extracted Kimi emission methods also verify blocked-send failure followed
by delta=150 recovery and a zero duplicate delta; the full Kimi session suite is
added but not run in a complete engine workspace. Codex bundles successfully;
Core build/typecheck and DSH build pass. Full Codex typecheck hits unrelated mock
signature errors with the harness Vitest; Claude build hits an SDK union mismatch
outside the edited lines and its lint requires absent ESLint. No full-workspace
or authenticated runtime pass is claimed.
Root `pnpm check` stops at the same Claude SDK mismatch; `pnpm format` stops at
missing Prettier in cloud-api. Targeted formatting, docs check, and public/platform
boundary checks pass.

Still unresolved: same-ID resume/reset needs durable baseline restoration or an
explicit accounting-lifetime identity accepted by the consumer. No private backend
change, package publication, historical data repair, or Kimi artifact rollout is
authorized/performed by these scoped fixes. Model-unattributed Codex USD remains
unknown; do not restore guessed UI-model pricing just to fill the field.

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
