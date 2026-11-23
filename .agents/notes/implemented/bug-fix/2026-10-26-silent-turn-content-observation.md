# Separate turn content from ACP replay evidence

Status: implemented
Translation: current
Issue: [#436](https://github.com/LodyAI/Lody/issues/436)
PR: [#1913](https://github.com/LodyAI/Lody/pull/1913)

[中文](2026-10-26-silent-turn-content-observation.zh.md)

## Abstract

Session metadata could make an empty Agent turn successful because settlement and
prompt replay shared one any-update observation. Each existing turn epoch now
retains independent event and content facts, including image generation's separate
callback path. ACP content is observed at enqueue; generated images count after a
matched nonempty history write, and settlement first joins the existing upload
owner. Silent completion fails visibly without replay, while image-only completion
can succeed. Synthetic tests cover local execution and storage; live providers and
the packaged desktop remain unverified.

## Decision and provider contracts

The issue's [reference branch comment](https://github.com/LodyAI/Lody/issues/436#issuecomment-5935995345)
identifies the two observations but also counts checklist plans and subagent
lifecycle events as content. The implementation follows the consuming contracts:

| Received update | Content settlement |
| --- | --- |
| Nonblank assistant text or thought | Content; thoughts remain expandable history items. |
| Root assistant image/audio/resource/link | Content; MessageHandler materializes attachments. Non-text thoughts have no corresponding history item. |
| Image-generation callbacks | Begin/status/failure establish event evidence. Only a matched nonempty `image_group` write establishes content; upload failure or refused attachment does not. |
| Ordinary tool call or sparse tool update with an ID | Content; the reducer materializes a tool row even without final prose. A failed tool is observable tool activity. |
| `plan` / `plan_update(items)` | Checklist/status only, including nonempty checklists. |
| `plan_update(markdown)` | Content when nonblank: a readable proposed-plan item. File plans, removal and empty markdown do not establish content. |
| Subagent event | Snapshot/progress is lifecycle status. Child text/thought/tool output counts; child rich output currently only marks the run incomplete. |
| Config, mode, commands, title, usage, user echo | No Agent content. |

ACP enqueue observation is not proof of downstream storage or completed tool
effects; flush failures retain their existing error/retry owner. Image generation
has a different boundary: AgentClient suppresses its raw tool notifications before
`onUpdateMessage`, then invokes `onImageGenerationBegin/End`. Independent review of
`fa1e38ec4` demonstrated a persisted image-only reply still becoming failed despite
376 green tests. Counting only the enqueue path was insufficient for both content
and replay protection. The owning suite now drives the real AgentClient router,
MessageHandler upload pipeline and SessionDocument history instead of simulating
that bypass as an ordinary ACP chunk.

Claude streams thought tags in ordinary text and emits checklist plans. Codex's
`CodexPlanStream` and Grok's `plan-review.js` can emit markdown proposals or ordinary
text. Core normalizes child output separately from lifecycle snapshots; Kimi's
recorded support includes main-agent task snapshots and final-tail output, not live
child deltas. Classification needs no new provider-name exception. See the
[shared reducer](../../../../packages/shared/src/acp/history-apply.ts),
[attachment materialization](../../../../apps/cli/src/lib/acp-agent-attachments.ts)
and [provider evidence](../../proposed/architecture/2026-09-26-subagent-events.md).

## Ownership and containment

`TurnPhase.hasPromptEvents` and `hasVisibleOutput` belong to one epoch, start false
and disappear with it. The shared private recorder checks epoch and replay
suppression before updating either fact. Buffered/flushed events and image
lifecycle callbacks therefore prevent replay without becoming equivalent to content.
Missing state or an absent observer refuses stale replay; missing/mismatched
content observation remains unknown and settlement fails open.

The existing image callId map now holds the begin-time target and epoch instead of
only a turn ID. Both inline and saved-path uploads carry that target into the
existing append helper. A successful matched image write records content for that
epoch; a reused assistant ID cannot authorize an older generation to write into
its successor. Late completion can still write its original, distinct assistant
entry, without marking the current turn. No new map, timer or resource owner is
introduced.

After prompt return, content observation joins `flushCodexGeneratedImageUploads`
before reading, while the turn still owns its state. This is the same drain already
used by finalization, moved ahead of the verdict rather than a second recovery
mechanism. Both execution paths await it through their existing Effect Promise
boundary. Stop interrupts the waiter; finalization still retains the upload owner
within the shared turn deadline; timeout/shutdown releases execution while owned uploads may finish later against their exact turn. Failed/refused uploads
retain the existing caught-error behavior and add no success fact. Events arriving
after all current uploads drain keep their captured target but do not retroactively
change an already-settled outcome.

A known silent turn finalizes, records `agent_no_output`, and advances only its
already-delivered input's terminal pointer. A normally resolved prompt never
replays. Disconnected ordinary turns retain one retry only before any owned event;
Inbox keeps its no-replay fence. Successful publication still follows the
[completion confirmation owner](2026-10-26-turn-completion-signals.md); image
observation bypasses neither local durability nor remote history confirmation.
Instance retirement and failed release continue to
follow the [retirement decision](2026-10-17-stale-acp-recovery-turn-ownership.md).
The Effect 4.0.2 assessment keeps synchronous facts ordinary and reuses the native
execution entry; migrating the unfinished image/Session/history orchestration
would expand this issue. No native boundary or unit-ledger fact changes.

## Verification and simplification

The ACP batching, execution, image-upload and AgentClient routing suites use
synthetic provider/upload/Git inputs, real local history and native
presence. Explicit gates cover upload tails, failure/refusal, begin-only and failed
status, Stop during the upload, late end callbacks and delayed writes across
different IDs or the same ID with a new epoch. Assertions inspect history, terminal
outcomes, submitted inputs and retained/released ownership. The independent
reviewer's original image-only fixture also passes.

The PR preserves actual baseline/fixed terminal captures and raw commands. Critical
image designs are temporarily removed against the same four suites: successful
image-write marking, upload drain before observation, captured epoch, lifecycle
replay marking, matched-write guard, begin-time target retention and preserving an
unowned image entry. The removals produced 2, 1, 2, 1, 1, 5 and 1 failed cases
respectively; all withdrawals are restored before submission. No source-string or mock-count assertion substitutes for these results.
The obsolete buffered/flushed replay inference was removed in favor of the one
epoch-owned event fact. No speculative Service, Layer or parallel recovery remains.

Node 26.12.1 is used without changing the floor or dependency versions. Root
`pnpm check` passes typechecking/lint/Effect lint, then reports 4,697 CLI tests passed
and one unchanged Git-identity relative-global fixture failed on this machine
(4 skipped). This is not full-repository green. Scoped checks and latest CI results
are reported in the draft PR; no live user transcript is a fixture.
