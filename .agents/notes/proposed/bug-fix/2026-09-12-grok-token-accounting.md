# Investigate Grok token undercounting

Status: proposed
Translation: current

[中文](2026-09-12-grok-token-accounting.zh.md)

PR: https://github.com/LodyAI/Lody/pull/661

## Abstract

Grok reports prompted research into low token totals without an original user sample. Synthetic execution proved that multiple prompt updates before a flush lost earlier usage, and a rejected persistence request lost its staged update. The follow-up implements ordered prompt delivery and retains failed payloads until acknowledgement, preserving ordinary per-prompt request semantics and token conversion. The actual user trigger, hosted aggregation, and exact release-source mapping remain unverified. This note stays proposed for those broader accounting questions; the confirmed client delivery fixes and their limits are recorded below.

## Scope and provenance

- Lody: `2055c001696ce508f075ac4e776d8bb93e112997`; Grok adapter 0.1.3: `c962338e3e6e68858e0bf92e9671a84b9a07e055`; Core 0.1.4: `0710756b1e257bfd3630d196e02fdf998e758989`.
- [Runtime manifest](../../../../packages/acp-extension-grok/runtime-manifest.json) pins official `@xai-official/grok` 1.0.13. The downloaded [official npm platform artifact](https://registry.npmjs.org/@xai-official/grok-darwin-arm64/1.0.13) has tarball SHA-1 `1da22c03bd828189662ed0ebc22788669e74bdc3`. Brotli decompression yields 133486016 bytes, SHA-256 `8669e0fdadceec25b8c159c355f427ffbd82583525d774b6ab1522197ea83b80`, exactly matching [the managed executable pin](../../../../apps/cli/src/agent/managed-agent-runtime.ts). Only `--version` was executed: `grok 1.0.13 (5e9a58528b76)`; no model or billing request was made.
- Official public source was inspected at `37949780c144e37df692e3d669051a21fec24f20`. No matching 1.0.13 tag was found, and fetching the binary's abbreviated build ref failed. This source supports the contract but is **not proven identical to the pinned binary**. Adapter tests are synthetic, not runtime captures.
- Work stayed in this independent worktree and temporary directories. No user configuration, original session directory, transcript, credential, hosted backend source, or production endpoint was used.

## Findings at the research baseline

| Hypothesis | Evidence and verdict |
| --- | --- |
| Cache/reasoning subtracted twice | Not supported by inspected public source. [PromptUsageModel](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-shell/src/extensions/notification.rs#L193) makes cache reads/creation subsets of input; reasoning is a subset of output. Adapter `normalizeUsageModel` turns `(1000,250,300,100,50)` into `(600,200,300,100,50)`: both sum to 1250. Removing subtraction would count 1700. Exact binary wire semantics still need an isolated fixture run or release-source mapping. |
| Only final LLM request counted | Adapter reads `_meta.usage`, not sibling `_meta.inputTokens/outputTokens`. Official [response metadata tests](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-shell/src/agent/mvp_agent/prompt_response_meta_tests.rs#L87) and [ledger](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-chat-state/src/usage.rs#L107) support whole-prompt, multi-call, per-model totals. `numTurns` counts main loop calls; it must not multiply already accumulated tokens. No evidence of a last-call-only bug in the adapter. |
| Incremental versus cumulative mismatch | **Confirmed local data loss.** Adapter emits once per prompt; `UsageTrackingService.applyUpdateToState` replaces `staged` except for Codex compaction. Two prompt totals 1250 then 2500 before one flush emit only 2500, losing 1250 (33.3% of the combined 3750). `MessageHandler.runTurnCloudSideEffect` skips offline flushes, providing a concrete route to multiple staged prompts in cloud composition. |
| Across successful per-prompt flushes | Service emits `[1250,2500]`, not session snapshots `[1250,3750]`. Core's [usage type](../../../../packages/acp-extension-core/src/usage.ts) declares neither delta/snapshot semantics nor event identity. Public [cloud DTO](../../../../packages/cloud-api/src/index.ts) exposes `upsertSessionUsageFromCli` without documenting its aggregation. If the hosted owner expects snapshots, even ordinary multi-turn sessions undercount; **that backend behavior is unverified**, not inferred from the method name. |
| Incomplete first wins deduplication | **Confirmed conditional behavior, not confirmed production cause.** `usageForPrompt` accepts any object, including `{usageIsIncomplete:true}` or `{}`, normalizes missing counters to zero, and remembers the prompt ID before a later complete object arrives. A synthetic partial prompt response followed by complete `turn_completed` loses the latter's 1250 tokens. Public normal completion paths share a frozen usage result, so differing early/late totals are not established for that path. |
| Lost modelUsage | Adapter preserves multiple model rows; parser and `AgentClient.sanitizeModelUsage` preserve all five token buckets. `AgentClient` constructs a row from total usage if the map is absent and a current model exists. If both are absent, tracking flush discards the update; the synthetic direct-service case confirms this guard, **not** that a normal Grok session lacks its model. A partial nonempty map is not reconciled against top-level totals. |
| UI drops independent buckets | Inspected input/parser/merge paths retain all buckets. `session-usage.ts` and the session popover display context occupancy and rate limits, not lifetime billed tokens. Workspace charts use server-supplied `timeline.totals.tokens`; their breakdown includes input, output, cache read+creation, and reasoning. No local missing-bucket calculation was found; server calculation and the user's actual screen remain unknown. |
| Persistence failure | **Confirmed independent loss path.** `flushKey` clears staged state before mutation; rejection is logged, then cleanup removes empty pending state. A synthetic rejected mutation followed by another flush makes no retry. The nearby MessageHandler claim that failed flushes retain merged totals is inaccurate for an attempted mutation; skipped offline flushes retain only the latest staged update. |

Source anchors: adapter [proxy](../../../../packages/acp-extension-grok/src/proxy.js) lines 120–157, 231–239, 537–542, 800–810, 874–885; client [parser](../../../../apps/cli/src/agent/lody-acp-extension.ts) lines 81–96 and [AgentClient](../../../../apps/cli/src/agent/agent-client.ts) lines 305–341, 1474–1480; [tracking service](../../../../apps/cli/src/lib/usage/usage-tracking-service.ts) lines 168–218, 223–258; [MessageHandler](../../../../apps/cli/src/lib/message-handler.ts) lines 1055–1138; UI [calendar](../../../../packages/components/src/components/settings/usage-calendar-visualization.tsx) lines 798–821, 1938 and [session usage](../../../../packages/components/src/lib/session-usage.ts) lines 100–117.

## Completeness, replay, and cost limits

Public upstream [freeze logic](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-shell/src/session/acp_session_impl/turn.rs#L1703) distinguishes prompt and session ledgers: background children can finish after the prompt snapshot, with later spend recorded only to session totals. Its incomplete flag can therefore mean actual missing tokens, not only unknown cost. The adapter strips this flag after suppressing cost and does not reconcile a session billing ledger. This is a supported upstream limitation to investigate with the pinned runtime, not a measured user incident or proof that deduplication alone can recover late child usage.

`isReplay:true` completion events intentionally emit no billing update. Removing this guard risks counting restored history again. Missing IDs bypass deduplication; the bounded 256-ID cache also cannot serve as durable accounting identity. Those risks tend toward duplication and do not explain the demonstrated undercount.

`costUsdTicks / 10_000_000_000` agrees with public upstream; 250000000 ticks becomes $0.025 in the executed fixture. `usageIsIncomplete` and row `costIsPartial` remove cost but preserve tokens. Unknown cost must remain distinct from zero. The unused-for-Grok merge path currently defaults absent per-model costs to zero, so simply routing Grok into that helper needs care.

The OSS local platform intentionally has `usage:null`; this cloud tracking path is inactive there. No authenticated product-cloud access should be added to local composition as a fix. First identify whether the complaint refers to hosted workspace usage, context occupancy, or a separate provider counter.

## Proposed correction and next evidence

1. Core and adapter/client owners should define explicit accounting units (prompt delta or session snapshot), stable event identity, completeness, and replacement semantics. Keep existing inclusive-to-disjoint conversion until exact-runtime evidence contradicts it. Do not change a Spec merely to bless the current mismatch; any eventual guarantee change needs a draft and both language versions.
2. For confirmed loss before flush, accumulate distinct prompt deltas without resetting at flush boundaries if the downstream expects session snapshots, or persist idempotent prompt records if it expects events. Choose only after checking the hosted owner's public contract. Blind summation doubles cumulative providers; changing only Grok to use the current merge helper does not solve retries, restarts, or partial corrections.
3. Preserve acknowledged baselines and pending records until persistence succeeds. Test deterministic rejection/retry and in-flight updates with an idempotent downstream identity; never retry additive writes without one.
4. Preserve completeness and per-prompt previous contribution so a proven richer replacement can correct earlier data without double counting. Empty/incomplete reports must not falsely finalize accounting. Background-child reconciliation may require an upstream session-usage source; the adapter's context/billing refreshes are not substitutes for token accounting.
5. Request only sanitized structured diagnostics: client/adapter/runtime versions and hashes, product surface/time range, opaque prompt IDs, event order, token buckets, `modelUsage`, completeness flags, replay flags, and flush outcome. Include two prompts, a multi-call tool loop, and controlled background completion/cancel. No raw prompts, model text, paths, credentials, or real transcripts belong in fixtures. Compare boundary totals with the upstream ledger and the hosted response to locate the actual user's loss.

## Verification and handoff

### Authorized implementation, 2026-09-13

The confirmed client losses are fixed in `UsageTrackingService`: Grok updates enter
an ordered queue immediately; other providers retain snapshot coalescing and Codex
compaction. Every attempted payload keeps its attribution and remains queued until
`success:true`. A failed attempt stops that drain and is retried by a later flush;
concurrent callers share the drain. New arrivals during delivery are drained in order.
No adapter, Core, hosted API DTO, model attribution, cost normalization, or local
composition change is included. The [delivery draft](../../../../specs/usage-delivery.md)
records the process-local guarantee.

This deliberately preserves the sequence a connected client already sends after
each prompt. An adapter cumulative snapshot or a client delta sum would select an
unverified hosted aggregation rule and could introduce double counting. Successful
delivery still cannot prove correct hosted totals. Retry after an ambiguous server
commit requires the hosted upsert's idempotency contract; no new exactly-once claim
is made. Queued records are memory-only and can grow while offline; process exit
still loses pending delivery. Partial-first deduplication and late background usage
remain the adapter/upstream questions described above, not silently claimed fixed.

The updated offline reproducer now expects both 1250 and 2500 (sum 3750), and an
identical payload on retry. The owning Vitest suite covers prompt ordering, all
buckets/unknown cost, caller mutation isolation, rejection and unsuccessful ACK,
concurrent flushes, arrivals during delivery, cumulative-provider behavior, Codex
compaction, and ACP-session isolation. Tests execute the current service with only
the HTTP mutation boundary replaced. The earlier research observations below are
historical and describe the pre-fix revision.

Follow-up verification: **8/8** service tests passed using an isolated esbuild bundle
and Vitest with the catalog-compatible Convex client; updated research assertions
and **56/56** existing proxy tests passed. Changed TypeScript files passed scoped
Prettier and esbuild compilation; the platform boundary guard passed. CLI typecheck
was attempted but cannot start (`tsgo` is absent in this dependency-free nested
worktree). No full application build/check or deployment is claimed.

[Offline reproducer](2026-09-12-grok-usage-repro.mjs) bundles the **actual current** proxy/Core and tracking-service code. Only the service's network client, DTO reference, and error formatter are replaced; assertions inspect emitted/persisted payloads, with no sleeps or network. It also bundles the existing adapter proxy suite. From the repository root:

```sh
grok_usage_tools=$(mktemp -d /tmp/grok-usage-tools-XXXXXX)
npm install --prefix "$grok_usage_tools" --ignore-scripts --no-audit --no-fund esbuild@0.28.2
node .agents/notes/proposed/bug-fix/2026-09-12-grok-usage-repro.mjs "$grok_usage_tools/node_modules/esbuild/lib/main.js"
# Run node --test <printed bundle directory>/existing-tests.mjs
```

Research assertions passed; the bundled existing proxy suite passed **56/56**. This verifies proxy behavior and the tracking service's local output boundary, not AgentClient/MessageHandler end-to-end execution, the official model runtime, hosted persistence, or rendered UI. Official Rust behavioral tests were inspected, not run. No full application typecheck/build/test or `pnpm check`/`pnpm format` was run: this nested worktree has no installed root dependencies and no product code changed. No commit or PR was created.

Initial `pnpm run docs status` reported 20 pre-existing broken links, mostly uninitialized unrelated submodules. Final `pnpm run docs check` failed on 15 remaining pre-existing links after Core initialization; it reported no error in this research note. Unrelated links and SHA baselines are not repaired here. There are no registered protected topics. Related [usage-share note](../../implemented/feature/2026-09-09-usage-share-image.md) owns presentation only; this proposal adds accounting research and does not replace its decision.
