# Separate turn content from ACP replay evidence

Status: implemented
Translation: current
Issue: [#436](https://github.com/LodyAI/Lody/issues/436)

[中文](2026-10-26-silent-turn-content-observation.zh.md)

## Abstract

Session metadata could make an empty Agent turn successful because settlement and
prompt replay shared the same any-update observation. MessageHandler now stamps
content on the existing turn owner at enqueue, preserving it through flush while
keeping every event conservative for replay. Empty or metadata-only completion
records `agent_no_output`, advances the delivered input's pointer and publishes a
failed outcome. The fixture covers the real local execution/history boundary;
live providers and the packaged desktop remain unverified.

## Decision and provider contracts

The issue's [reference branch comment](https://github.com/LodyAI/Lody/issues/436#issuecomment-5935995345)
identifies the two observations but also counts checklist plans and subagent
lifecycle events as content. This implementation follows the consuming contracts:

| Received update | Content settlement |
| --- | --- |
| Nonblank assistant text or thought | Content; thoughts remain expandable history items. |
| Root assistant image/audio/resource/link | Content; MessageHandler materializes attachments before history persistence. Non-text thoughts have no corresponding history item. |
| Tool call or sparse tool update with an ID | Content; the reducer materializes a tool row even without final prose. A failed tool is observable tool activity. |
| `plan` / `plan_update(items)` | Checklist/status only, including nonempty checklists. |
| `plan_update(markdown)` | Content when nonblank: a readable proposed-plan history item. File plans, removal and empty markdown do not establish content. |
| Subagent event | Snapshot/progress is lifecycle status. Child text/thought/tool output counts; child rich output currently only marks the run incomplete. |
| Config, mode, commands, title, usage, user echo | No Agent content. |

This is a protocol-content observation, not proof of successful downstream storage
or completed tool effects. Existing flush failures retain their own error/retry owner.
The locked Claude adapter streams thought tags in ordinary text and emits checklist
plans. Codex's `CodexPlanStream` and Grok's `plan-review.js` can emit markdown
proposals or fall back to ordinary text. Core normalizes child output separately
from lifecycle snapshots; Kimi's documented support is main-agent task snapshots
and final-tail output, not live child deltas. No provider-name exception is needed.
See [the shared reducer](../../../../packages/shared/src/acp/history-apply.ts),
[attachment materialization](../../../../apps/cli/src/lib/acp-agent-attachments.ts)
and [provider evidence](../../proposed/architecture/2026-09-26-subagent-events.md).

## Ownership and containment

The trigger is normal prompt resolution with no content. `TurnPhase.hasVisibleOutput`
belongs to that exact epoch, starts false and disappears with the turn; enqueue
checks the stamped target epoch before setting it. This avoids a second registry,
retention policy or flush-time scan. Native replay suppression runs first. Late
output for a finalized turn cannot make a newly admitted turn successful.

`hasPromptEventsForTurn` retains buffered/flushed evidence of any ACP update;
missing state or an absent observer refuses stale replay. Content observation
returns unknown for a missing/mismatched owner and settlement fails open. A known
silent turn finalizes normally, records a visible failure, and advances only the
already-delivered input's terminal pointer. It never retries a successfully
resolved prompt. Ordinary disconnected turns retain one retry only before any
event; Inbox keeps its no-replay fence.

Cancellation, raw-request drain, instance retirement, presence release and flush
recovery stay with their existing owners. A content failure adds no wait, resource
or teardown fence. The [retirement decision](2026-10-17-stale-acp-recovery-turn-ownership.md)
continues to govern replacement and failed release. The Effect 4.0.2 feature/fix
assessment keeps this synchronous observation ordinary: migrating MessageHandler
would pull unfinished Session/history dependencies into the issue. No native
boundary, dependency, consumer or unit-ledger fact changes.

## Verification and simplification

The owning ACP batching and execution suites use synthetic provider/Git inputs,
real Session/SessionManager/MessageHandler, offline SessionDocument, native presence
and explicit completion signals. They inspect terminal history, failure notices,
outcome facts, submitted inputs and released ownership. Cases include metadata
before/after flush, no events, empty and visible content, tool-only/failing tools,
plan variants, child content/status, next-turn isolation, replay suppression,
unobservable state and existing Stop/retirement/retry failure paths.

The original any-update observer makes the metadata-only acceptance tests fail
with `handled` instead of `failed`. The same two suites pass all 376 cases after
restoration. Temporary simplifications produce these behavioral failures:

| Removed design | Failed cases |
| --- | --- |
| Separate content observation; reuse any-event verdict | 16: metadata/empty/checklist/lifecycle become success. |
| Turn latch; inspect only the pending buffer | 3: flushed content disappears, including successful stale recovery. |
| Target epoch check | 1: old-turn output contaminates the new turn. |
| Conservative unknown-state replay policy | 2: missing observation permits replay. |
| Child rich-content exclusion | 1: an incomplete marker becomes successful output. |

All temporary withdrawals were restored. The design adds one turn-local boolean
and one private classifier; no exported helper, Service, Layer, map, timer or new
recovery path is retained. `pnpm format`, CLI typechecking, `check:quick` (including
Effect/public boundaries) and `docs check` pass with Node 26.12.1. Root `pnpm check`
reaches CLI tests (4,685 passing) but fails the unchanged Git-identity relative-global
fixture, which also fails alone with this machine's owner identity. This is not a
full-repository green result. Captured acceptance and raw ablation evidence belong
to the draft PR; no live user transcript is a fixture.
