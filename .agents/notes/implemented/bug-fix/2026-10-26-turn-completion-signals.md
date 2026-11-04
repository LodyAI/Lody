# Publish completion after turn release and history confirmation

Status: implemented
Translation: current

[中文](2026-10-26-turn-completion-signals.zh.md)

## Abstract

Issue #1785 exposed unread metadata advancing before history finalization and
successful notification facts surviving unconfirmed synchronization. Completion
publication now runs after turn release: an Effect policy persists the actual
history backend, confirms attached remote history/control synchronization, and
only then publishes unread and success. Confirmation retries have a 30-second
budget and shutdown cancellation; notification sends remain best effort and are
never retried. Local-only completion uses local durability, and CLI history
summaries prefer a finished assistant's completion time. This is a native policy
boundary, not completion of the Session/history migration or proof of client rendering.

## Evidence and decision

Diagnosis at `34d403b8b4b71a2f0b490d1bedd7bac650b57c71` confirmed early unread writes,
ignored false sync results and creation-time summaries using synthetic method
experiments. Current notification submission was already after the visible-turn
scope, unlike the older nightly in [#1785](https://github.com/LodyAI/Lody/issues/1785).
The integrated tests now exercise production execution, history storage and publication.

`finalizeACPState` no longer publishes unread or waits for remote sync. A failed
live history finalization propagates so it cannot authorize successful completion;
teardown remains best effort and post-history usage errors remain contained.
ACP arriving during finalizing presence cannot bypass the completion boundary.
`finalizeTurn` no longer repeats sync/unread work.

```text
required history finalization → presence/Inbox release → freeze completion time
  → local backend flush → attached-generation history/control confirmation
  → unread metadata + one-shot outcome notification
```

The timestamp is frozen before waking successor work. Per-Repo activity write
serialization keeps older completion writes from lowering session or parent activity;
the parent write acquires its queue only after releasing the child's queue.
`session show` uses valid `endedAt` for finished assistant entries and falls back
to `timestamp`. Stored creation timestamps and history order do not change.

## Ownership and failure containment

- Trigger: a finalized turn whose resources were released. Notification audience
  still comes from the frozen completed invocation; agent inputs may mark unread
  without notifying a human.
- Owner: the existing execution Host drain owns `publishTurnCompletionLegacy`.
  The native policy has injected Effect capabilities, Schedule retry and a Clock
  deadline; it creates no detached Fiber, notification journal or recovery map.
- Handoff: presence/execution/Inbox release precedes publication. Neither a slow
  sync nor notification transport retains the prompt slot. Failed/unknown outcome
  attention is independent of success confirmation.
- Cancellation: MessageHandler shutdown aborts confirmation before the Host drain,
  so the 30-second gate cannot consume the coordinator's 15-second drain budget.
  The waiter's underlying read-only sync remains with Repo/backend owners; it has
  no late publication callback. Begun local writes and sends stay owned until settled.
- Failure: false or rejected confirmation retries within 30 seconds; expiry logs
  a diagnostic and withholds unread/success. It neither fails successful Agent work
  nor replays it. Publication channels run independently and preserve combined
  failure causes. A remote generation replacement never becomes a local success.

The existing best-effort notification contract rules out a durable outbox and
reconnect/send retries. Bounded pre-publication confirmation is the smaller fix;
a failure diagnostic is not durable replay. After expiry, later sync does not
reissue these signals. Intentionally local-only work needs no cloud receipt.
Remote receipts confirm backend convergence, not receipt/rendering by each client.

## Effect boundary and verification

Pinned Effect 4.0.2 drives the new finite policy and TestClock regressions.
`publishTurnCompletionLegacy` is its sole Promise execution facade, consumed by
`SessionExecutionService.releaseVisibleTurn`; remove it when the Session caller,
history/backend and notification owners compose native Effects. Those existing
Promise dependencies remain unfinished, explicitly recorded in the
[ledger](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md#unit-ledger).
No backend, ACP, or whole-turn migration is claimed.

Tests cover release-before-sync, retry/expiry, cancellation and late receipts,
local-only publication, metadata races, storage failure and notification provenance.
Integration tests retain the real history writer and execution scopes; no live dsh
or packaged UI/device notification validation is claimed. Check results and
remaining environment failures are reported with the change.

Related decisions: [finalizing display](2026-10-06-finalizing-status-label.md),
[Code Collab ownership](2026-10-21-code-collab-turn-finalization-wait.md), and
[notification presentation](../feature/2026-10-23-notification-reply-preview.md).
