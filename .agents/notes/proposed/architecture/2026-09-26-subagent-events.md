# Normalize provider subagent events at the adapter boundary

Status: proposed
Translation: current

[中文](2026-09-26-subagent-events.zh.md)

## Abstract

Builtin providers expose different subagent surfaces: separate child transcripts,
task summaries, or queryable output tails. Lody previously neither consumed native
child-session lifecycles nor retained foreign child-session output. We propose
three normalized event kinds in Core, with explicit per-run capabilities and
ACP content reuse. This adds adapter work but makes missing provider output
visible rather than pretending every task has a complete live transcript.
The Codex-first phase is implemented locally with synthetic tests; other providers
remain proposed, and live deployment parity is not established.

## Event inventory

The target schema and semantics live in the [draft Spec](../../../../specs/subagent-events.md).
The arrows below are target mappings; only Codex is implemented in this change.

| Provider | Native input and existing adapter surface                                                                                                                                                                        | Proposed mapping and limits                                                                                                                                                                                                                                |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude   | SDK `task_started`, `task_progress`, `task_updated`, `task_notification`; child messages use `parent_tool_use_id`. Native ACP mode emits `subagent_spawned`, `subagent_state_update` and ordinary child updates. | Start/metadata/terminal facts → snapshot; summary/last tool/usage → progress; child text/thought/tool updates → output. Only actual subagent tasks enter this stream; Bash/background/scheduled tasks remain separate.                                     |
| Codex    | `collabAgentToolCall`, `subAgentActivity`, child `turn/*`, `item/agentMessage/delta`, reasoning and tool `item/*`. Adapter already emits native ACP spawn/state and child output.                                | Lifecycle → snapshot; child content → output. Do not claim native numeric progress when absent. Tool activity can remain in output without synthetic counters. Reused terminal threads need new run identities.                                            |
| Grok     | `_x.ai/session_notification`: `subagent_spawned`, `subagent_progress`, `subagent_finished`; child ordinary ACP output; xAI `tool_call_delta_chunk` carries raw argument fragments.                               | Lifecycle → snapshot; duration/turns/tools/context/errors → progress; child ACP → output. Buffer argument fragments within the adapter and emit valid ACP tool updates, never parse incomplete JSON as complete input.                                     |
| Kimi     | Main-agent `task.started` / `task.terminated` → Core `_meta.lody.task`; list/output/cancel endpoints. Child executor writes output after completion.                                                             | snapshot plus terminal summary; stream empty; outputRead final_tail. ACP subscribes to main-agent content, not child deltas. Live child output requires new engine-to-adapter subscription work.                                                           |
| Pi       | Child `message_update(text_delta)` appends a bounded buffer; `tool_execution_start` publishes lastToolName; child exit publishes lifecycle. Core list/output/cancel supported.                                   | snapshot and progress; outputRead live_tail; stream currently empty. Live text output is feasible by forwarding already-received deltas, but is not shipped. Tool names are progress, not full tool calls; thought/tool-result feeds need additional work. |
| DSH      | Preset subagent/spawn/fork/control tools; ACP processes only owned registered Agent/session events.                                                                                                              | Existing parent tool calls remain parent output. Do not synthesize a child solely from its title. Dedicated child discovery, ownership and event subscriptions are needed before advertising normalized lifecycle/output.                                  |

All stream categories are advertised only once actually implemented and verified
for the selected runtime. Plan streaming is allowed by the target schema but not
claimed for every provider. Cancel support is independently negotiated; native
spawn/state support alone does not imply cancellation support.

## Rationale and alternatives

1. Three events instead of one large provider union: full task snapshots make
   state recovery explicit, sparse progress preserves optional observations,
   and ACP output keeps existing rich content/tool behavior. The UI has one reducer.
2. A run is not an agent: Codex can reactivate a terminal thread. Grouping only by
   native agent ID merges different executions and accepts late output incorrectly.
3. Observation loss is not execution failure. Existing task status unions collapse
   several outcomes; the new projection retains cancelled/unknown and reasons.
   Do not rewrite legacy rows to infer facts that were never stored.
4. Keep progress separate from accounting. Grok context occupancy is not cumulative
   billing, while providers account for child usage differently.
5. Keep queries separate from streaming. Pi's repeated text tails overlap; Kimi's
   output appears at completion. Calling either `output: true` a live transcript
   would overpromise and can duplicate content.
6. Use ACP delivery order without envelope stream IDs or sequence numbers.
   This keeps the initial contract small without suggesting a replay guarantee
   the providers do not supply. Reconnection marks observation incomplete;
   future history recovery needs its own reconciliation contract.

An alternative is native ACP child sessions end to end, adding only Core progress
metadata. That follows the draft directly and avoids a new content envelope, but
requires host support for multiple wire identities, draft variants and xAI
normalization; task-only providers still need synthetic child sessions. The
proposed envelope reuses ACP payloads while centralizing that adaptation. Review
may choose the native transport instead without changing the conceptual three
event categories. Poll-only unification is simpler but loses tool/thought fidelity
and introduces overlapping snapshots; lifecycle-only unification does not meet
the requirement to inspect execution details.

## Evidence, versions and remaining work

### Codex-first implementation

Companion PRs: [Core contract](https://github.com/LodyAI/acp-extension-core/pull/15)
and [Codex adapter](https://github.com/LodyAI/acp-extension-codex/pull/56).
Host/UI PR: [Lody #996](https://github.com/LodyAI/Lody/pull/996).
Standalone Codex release requires publishing Core and updating its dependency first.

The user requested Codex validation before other provider work. Core owns the
`_lody/subagents/event` validator and bilateral v1 capability. Codex adapts its
existing native router, with new opaque run IDs for reused executions and no
synthetic numeric progress. The client validates root/run ownership before
forwarding events or accepting consent requests. Child permission tool IDs are
namespaced on the root interaction path; canonical child output retains native IDs.

```text
Codex child events → Core envelope → AgentClient → HistoryWriter
                                                  └─ subagent_task.run
                                                     ├─ snapshot / progress
                                                     └─ text / thought / tool / plan
```

Each run stays in its initiating assistant entry, including updates received
during later turns. Tool enrichment is isolated per run and permission mirrors
do not duplicate edit evidence. Message/turn identities stay child-local. Existing
histories remain compatible. The daemon advertises `subagentEvents` v1; new live
UI is gated, while retained transcripts are readable offline. UI work was delegated
to the requested UI Designer role: latest action in the compact task list and
full retained history in a dialog.

No `streamId`, sequence field, replay guarantee or new scheduler is introduced.
Disconnect preserves partial history as unknown/incomplete. No per-run cancellation
or output query is claimed. Non-text message chunks currently mark the transcript
incomplete; tool rich content is retained. No transcript cap is added. Codex's
adapter is bundled, so this phase does not change its native runtime pin.

Behavioral validation covers negotiation, permission ownership, connection loss,
nested/reused runs, late output, cross-turn persistence and tool isolation. Live
Codex testing is still required before enabling other adapters. Full-provider
rollout and durable reconnect mappings remain proposed; this note therefore stays
in `proposed`, and the linked Spec remains a draft.

Validation: Core's 7 tests, 33 Codex negotiation/collaboration tests, 109 targeted
host tests, 12 panel interaction tests, 21 conversation-reader tests and all 1,182
shared tests passed. Relevant typechecks, lint, documentation and boundary checks
passed. The full Codex run had 811 passes and two failures in unchanged symlink-path
tests. Broader host/UI runs encountered unchanged GitHub-shim failures and provider
dialog timeouts and were stopped; full-repository green is not claimed.
The UI Designer inspected light/dark Storybook screenshots using a stand-in history
renderer; the real tool/thought renderer still needs desktop/live-run verification.

### Source inventory

- Claude pin `f88c966a`, Codex pin `5e18d2a0`, Grok wrapper pin `21768816`,
  DSH pin `48dc9556`, Kimi source pin `4befe38f`, Pi source pin `49570ee8`.
- Kimi's managed source is `d4caf044fe0c`, Pi's is `e6debc2f6aac`; their inspected
  task/output behavior has the same limitations. A source gitlink is not the
  managed artifact: future support requires publishing and pinning the artifact.
- Grok public source `f0e3be11` is 1.0.41. The same lifecycle/progress surfaces
  occur in public 1.0.38 snapshot `4247f661`; no exact 1.0.40 source snapshot/tag
  was found. Lody's 1.0.40 binary remains unverified.
- Host `AgentClient.sessionUpdate` rejects foreign session IDs; initialize does
  not advertise native subagents. Grok wrapper passes unhandled notifications
  through; the host does not interpret xAI child lifecycle notifications.
- Existing [client-surface decision](../../implemented/simplification/2026-09-12-subagent-client-surface.md)
  removed unused host list/output wrappers. This proposal adds a real UI consumer;
  it does not claim those wrappers already exist. Existing
  [single-writer decision](../../implemented/architecture/2026-09-07-single-history-writer.md)
  remains authoritative for persistence ownership.
- No live provider executions. Remaining provider work needs runtime publication
  where applicable, native identity/recovery evidence, and tests for each adapter's
  event ordering and bounded output-tail behavior; Codex tests are not evidence
  that other providers have equivalent capabilities.

Source entry points: [Claude routing](../../../../packages/acp-extension-claude/src/native-subagents.ts),
[Codex routing](../../../../packages/acp-extension-codex/src/subagents/CodexSubagentEventRouter.ts),
[Kimi ACP](../../../../packages/acp-extension-kimi/packages/acp-server/src/session.ts),
[Kimi task output](../../../../packages/acp-extension-kimi/packages/agent-core-v2/src/agent/tools/agent/subagent-task.ts),
[Pi tasks](../../../../packages/acp-extension-pi/src/subagents.ts),
[DSH adapter](../../../../packages/acp-extension-dsh/src/adapter.ts),
[Grok events](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/extensions/notification.rs),
[Grok routing](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/leader/server.rs).
