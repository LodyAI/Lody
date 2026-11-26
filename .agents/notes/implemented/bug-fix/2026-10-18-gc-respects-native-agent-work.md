# Session GC respects native agent work

Status: implemented
Translation: current
PR: [#1679](https://github.com/LodyAI/Lody/pull/1679)

[中文](2026-10-18-gc-respects-native-agent-work.zh.md)

## Abstract

Idle GC stopped Claude sessions that were still working. A turn ends with
`end_turn` while a `run_in_background` shell or a Monitor keeps running, and
Claude Code later wakes the model by itself when that task finishes. Lody saw
none of this: only user actions and turn ends counted as activity, so 20
minutes after the turn GC killed the agent process together with its
background tasks. The agent now reports a new Core level,
`_lody/session/activity_update`, which says whether it is running and how
many background tasks are live. GC never cleans a session whose agent is
running, spares one that only waits on background tasks for up to 24 hours,
and treats output after a turn as activity. Agents that do not report the
level keep the old rules unchanged. Pending `ScheduleWakeup` and cron jobs that have no live task are
still not protected.

## Problem

`SessionGCManager` cleans a session when its idle time passes 20 minutes and
it has no active turn, active goal, pending updates, pending user work, or
archive in flight. Idle time is measured from `touchSession`. That function
ran on user actions, history RPCs and turn finalization. It deliberately did
not run on ACP updates.

The Claude adapter holds a prompt open only for the background subagents that
the turn spawned. It never holds one for a shell (its comment: "a hold must
NEVER wait on a shell") and ignores Monitor tasks. So three cases looked idle
to GC:

- a background shell or Monitor that runs for more than 20 minutes after the
  turn: GC killed it before it could wake the model;
- the model turn Claude starts by itself after such a task finishes: its
  output went to the finished turn as a late update and did not touch the
  session, so the work could be killed partway through;
- a `ScheduleWakeup` or cron job set to fire more than 20 minutes later.

## Decision

1. **A Core activity level.** `acp-extension-core` adds the `sessionActivity`
   capability and the `_lody/session/activity_update` notification
   (`state`: `idle` / `running` / `requires_action`, plus
   `backgroundTaskCount`). It has replace semantics, and a client that receives
   no update assumes `idle` with no tasks. The Claude adapter builds it from the
   SDK's `session_state_changed` and `background_tasks_changed` messages. It
   skips tasks the SDK marks `ambient`, which the SDK says are not activity.
2. **GC reads the level.** `AgentClient.getNativeWork()` maps the level to
   `running` (running or waiting on a permission), `background`, or null. It
   reads the level only when the agent advertised the capability, and only for
   the current ACP session. `MessageHandler.getNativeWork()` reads it from the
   live session, so the state disappears with the process. GC never cleans or
   evicts a `running` session. The idle sweep spares a `background` session
   until its idle time reaches `nativeBackgroundMaxIdleMs` (24 hours,
   `LODY_SESSION_GC_NATIVE_BACKGROUND_MAX_IDLE_MS`). Memory-pressure eviction
   may still reclaim it.
3. **Output after a turn counts as activity, for these agents only.**
   `MessageHandler.enqueueACPUpdate` calls `touchSession` when an update is
   routed to a finalized turn and the agent reports `sessionActivity`. That
   output comes from a model turn woken by a background task, a wakeup or a
   cron, so the idle clock restarts when that work ends rather than at the
   last user turn. Output inside a turn still does not touch: the turn already
   protects the session. An agent without the level keeps the old rule that
   only user actions and turn ends count, so its GC behavior does not change.

## Completion signals

Added 2026-11-16, hardened 2026-11-17. The same level also decides when a Turn counts as finished for
its reader. A Turn that ends while its agent still reports `running` or
`background` no longer marks the Session unread or sends the success notification
at release; `SessionExecutionService` waits on that agent instance's lifecycle
events, without a clock, and publishes once the agent reports idle, with the
later activity time. If the process ends first (idle GC after its 24-hour cap,
memory pressure, a crash, or ACP child exit without `Session.terminate`), the
conversation gets a `nativeWorkInterrupted` notice before completion is flushed,
the Session is still marked unread, and the user is alerted to an `unknown` result
(`native_work_interrupted`) instead of a success. If GC destroyed the Turn's `SessionDocument`
at termination, completion re-acquires the live document unless the Session was
archived or deleted. A newer Turn, Stop, archive, or delete withdraws the wait so
intentional teardown publishes no stale interruption.

The wait is not completion bookkeeping: it holds no write, so it does not count
in `inspectClientLoss` or the shutdown drain, which a background dev server could
otherwise hold for a day. Only the publication after it is owned work. Shutdown
withdraws the wait and publishes nothing, and a daemon restart loses it, so a
Turn whose background work was still live at restart gets no completion signal.
Agents that report no level keep immediate completion, as for GC. Failure and
cancellation attention is unchanged and never waits.

## Alternatives

- **Raise `LODY_SESSION_GC_IDLE_TIMEOUT_MS`.** This needs no code, but it keeps
  every idle session in memory longer and still fails for any wait longer than
  the new value.
- **Hold the prompt open for shells too.** The adapter rejects this on purpose:
  a background dev server can outlive every turn, so the prompt could never end.
- **Infer background work from history.** Background Bash tool calls are in
  history, but nothing there reliably says when the task ended. Only the SDK's
  live-task level does.
- **Publish completion at release and only show background work in the row.**
  The working mark already shows native work, but the unread mark and the
  notification still told the user the work was done while it was running.
- **Protect pending wakeups and crons from history.** History already holds
  enough to compute the next fire time (`collectPendingScheduledTasksFromHistory`).
  This was left for a separate change.

## Trade-offs and limits

- The 24-hour ceiling bounds a forgotten background dev server. Such a session
  is cleaned once its idle time reaches 24 hours. Memory pressure may evict it
  sooner, which kills its tasks.
- A pending `ScheduleWakeup` or cron job with no live task is not covered. It
  is still lost if no output arrives for 20 minutes. Whether the SDK lists
  pending wakeups in `background_tasks_changed` was not verified.
- The level needs a Claude adapter release that advertises `sessionActivity`
  and a Core release that defines it. Older adapters and other providers report
  nothing and keep exactly the old GC behavior, including late output not
  counting as activity.
- Added 2026-11-17 ([#2797](https://github.com/LodyAI/Lody/issues/2797)): the
  DeepSeek Harness adapter also reports the level, from native `agent/status` and
  the root session's live jobs. It used to force `quiet` job completion and reject
  every root step outside a prompt, so a job that finished while idle reached the
  model only with the next user message, and idle GC removed the process and its
  in-memory job registry after 20 minutes. It now keeps the native `wakeup`
  delivery and admits only the turn that claims the completion notice. A job still
  dies with its ACP process (eviction, crash, daemon restart); Harness has no
  cross-process job registry.
- The adapter sends the level without awaiting it, so the SDK message loop never
  yields at these points. Ordering holds because each send reaches the
  connection before its first `await`.

## Verification

- Adapter: a stream test drives a background shell past the end of its turn and
  checks the levels sent (`running`/`idle` with 1 task, then 0 tasks, then the
  model's own turn). The test fails when the `background_tasks_changed` wiring is
  removed. The golden initialize snapshots now list the capability. The five
  failures in `incomplete-tools.test.ts` also occur on the unmodified adapter
  in this environment, which has no `claude` binary for `auth status`.
- CLI: GC tests cover `running`, `background` below and above the ceiling, the
  clean after tasks are gone, and pressure eviction. AgentClient tests cover
  capability gating and ACP session matching. A MessageHandler test checks that
  post-turn output resets the idle clock for an agent reporting the level and
  leaves it unchanged for one that does not; it fails when the touch is removed.
