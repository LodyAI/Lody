# Close dead turns and keep unpromoted queue rows watched

Status: implemented
Translation: current

[中文](2026-10-26-dead-turns-and-orphaned-queue.zh.md)

## Abstract

After a machine restart, a session could stay "busy" forever: its last assistant entry was
never finished, so the composer queued every message, Stop was hidden, and the daemon, seeing
no pending work, never ran the queue. The fix makes one fact decide the user-visible state —
whether the last assistant turn is finished — and makes the owning daemon responsible for
finishing turns that no execution owns: Stop closes such a turn, and a dispatch check closes it
once its user input has settled. The daemon also stops acknowledging the queue signal while
rows remain. Sessions already stuck before this change still need one trigger (Stop or a queue
edit), because idle sessions are not opened at startup.

## Problem

Clients derive two decisions from history: Stop is shown, and new messages are queued rather
than sent, while the last assistant entry is unfinished. Live presence and several metadata
pointers were consulted as well, and they disagreed:

- A restart's crash-recovery dispatch was rejected by Inbox admission before its prompt (the
  earlier execution's release was still unconfirmed). The user input was marked `failed`, but
  the assistant entry the recovery would have reopened stayed unfinished.
- The composer therefore queued every message; Stop required live presence and was hidden;
  the daemon's Stop path only closed an ownerless turn stuck in context compaction.
- A dispatch check that could not promote a queued row still wrote `messageQueueCheckedAt`,
  so the session was unwatched and the row was never retried. Why the first check skipped the
  row was not determined from the logs (a lease conflict or the queue row not yet synced are
  both possible); the fix does not depend on which.

## Decision

- **Single criterion in the UI.** `canStopAgentEnabled` is "last assistant turn unfinished, or
  a pausable goal". Live activity no longer gates Stop, so a turn whose agent died stays
  stoppable. Queue-versus-send already used the same criterion.
- **The owning daemon closes dead turns.** `SessionExecutionService.closeDeadAssistantTurn`
  runs under the session rewrite lease and rechecks that no active, current or runtime turn
  exists. It reads only the history tail directory, so Loro and Roost share it.
  - Stop on that turn closes it unconditionally: an unsettled user input becomes `canceled`
    (and its own dispatch pointers are retired) before the entry is force-finished, in the same
    order as an ordinary Stop. Stop still does not run the queue.
  - A dispatch check with nothing to run from history closes it before queue promotion, but
    only when the user input is `handled`, `failed` or `canceled`. A `processing` input still
    owes its crash-recovery run, which reopens the same entry.
- **Queue signal.** `markMessageQueueSignalChecked` acknowledges only an empty local queue, so a
  row that could not be promoted keeps the session watched and later changes retry it.

## Alternatives considered

- **Infer dead turns from metadata at startup.** Rejected: an idle session's metadata carries no
  hint, and opening every session document at startup is forbidden by the bootstrap-scan rules.
- **Keep presence in the Stop gate and fix only the daemon.** Rejected: any future state where
  presence is absent but the turn is unfinished would hide the only exit again.
- **Close any ownerless unfinished turn automatically.** Rejected for `processing` inputs, which
  crash recovery must still run on the same entry.

## Related, not implemented

The Claude adapter holds `session/prompt` open while background subagents it spawned are live,
which also makes Lody queue new input during that time. Settling the prompt at the answer and
treating background work as session activity (negotiated by capability) is a separate change in
the adapter repository. A longer-term direction — one daemon-owned execution state per session
read by the composer, MCP status and dispatch — was discussed and is not decided here.

## Verification and limits

- Execution-service tests: Stop closes an ordinary ownerless turn (input `canceled`, entry
  finished, pointers retired, status idle, Stop marker cleared); automatic closing skips a
  `processing` input and closes a `failed` one without rewriting it. The existing compaction
  Stop test still passes.
- Watcher test over a real `SessionDocument`: a queued row blocked by a held lease keeps
  `messageQueueCheckedAt` unchanged and is promoted and dispatched on the next check.
- Removing the queue-length guard or the settled-input guard makes the corresponding test fail.
- Not verified live: no desktop, web or daemon restart was exercised. The Stop button change
  reaches users only with a renderer release.
- Already-stuck sessions are not repaired automatically: with the new daemon, Stop closes a dead
  turn, and editing a queued row re-raises the queue signal.
