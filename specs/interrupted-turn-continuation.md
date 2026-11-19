# Continuing Turns interrupted by a restart

Status: draft
Translation: pending

## Scenario

A user asks an Agent for long work and Lody stops while the Turn is running: the desktop
installs an update and restarts, the machine reboots, or Lody and its Agents are killed.
Today the next start retires the interrupted input with an unknown result and logs
"not retried" (`apps/cli/src/orchestration/inbox/sqlite.ts`). The Session stays idle
with half-finished output until the user sends "continue" to each Session by hand.

## Decision

The owner chose (2026-11-19) that every Turn interrupted this way continues
automatically after the next start, whatever ended the process.

- **No replay.** The interrupted input keeps its current outcome: retired, result
  unknown, never dispatched again. This preserves the
  [Inbox non-replay decision](../.agents/notes/implemented/architecture/2026-10-12-operation-inbox.md)
  and [restart retirement](../.agents/notes/implemented/bug-fix/2026-10-29-inbox-no-durable-block.md).
- **One new continuation input.** For each retired execution the CLI resumes the Agent
  the ordinary way (`session/load` where supported, otherwise the existing history resume)
  and admits one new input, authored by Lody and visible in the conversation, whose whole
  text is `continue` — what users send by hand today. It carries no other instruction
  ([agent-text rule](../AGENTS.md)).
- **At most once.** An interrupted continuation is not continued again, so a crash loop
  cannot keep restarting work (owner: keep this simple).
- **The user wins.** Stop, a paused Inbox, archive or deletion, or new human input
  accepted before the continuation starts cancel it. The continuation queues behind input
  that is already pending, like any other input.

The owner accepts the risk that an Agent killed mid-action (for example a half-written
file) continues from that state.

## Durability prerequisite

A Session whose input the CLI accepted must still be listed and openable after a hard kill.
loro-repo's default 5-second trailing metadata debounce let a SIGKILL drop the entry that
lists a new Session while its history stayed on disk. Both repositories now persist
metadata without a debounce (owner, 2026-11-19: local incremental writes need no such
delay); `LODY-TURN-005` guards it.

## Open questions

- How the conversation labels the Lody-authored `continue`.
- Remote machines and cloud Sessions: whether a machine restart continues Turns that a
  different device dispatched.
- Scheduled automations: whether an interrupted scheduled run continues or waits for its
  next schedule.
- Whether the explicit "Automatic work cannot authorize recovery" admission rule needs a
  narrow exception for this input kind.

## Evidence

- Implementation inspected: `apps/cli/src/orchestration/inbox/sqlite.ts` (startup
  retirement), `apps/cli/src/orchestration/README.md` (non-replay contract),
  `packages/components/src/providers/workspace-writer-impl.ts` (`startSession` order),
  loro-repo 0.25.1 `MetaPersister` (5 s default meta debounce), `apps/cli/src/lib/loro/doc.ts`
  and `packages/components/src/providers/create-workspace-runtime.ts` (no override).
- Executed: a killed profile's `repo.sqlite3` holds the Session's history rows but no
  metadata row; with a seven-second delay before the kill a metadata row appears 5.2 s
  after the last history write and the Session is listed after restart.
- Implementation: detection reads Session metadata only. Dispatch claims an input with
  `processingUserMsgId`; every ending clears it except a process end. A crash leaves it, and
  shutdown quiesce now leaves it too (skipping only the cancel bookkeeping: user turn
  `canceled`, `lastHandledUserMsgId`, claim cleared) when the agent prompt was still running
  and the user had not stopped it; a finished prompt doing bookkeeping is canceled as before.
  The Inbox still retires the input. On restart the dispatch watcher re-dispatches the
  claimed input; when its Inbox input has ended and `machineId` is this Machine,
  `SessionExecutionService.continueInterruptedTurn` settles it like Stop instead of the
  send-again failure, then `session/interrupted-turn-continuation.ts` appends one user turn
  with text `continue`, author `{ kind: 'system' }`, id `lody-continue-<interrupted id>` and
  the interrupted input's agent, model, mode, options, MCP and Role selection; ordinary
  dispatch runs it. It is skipped for continuation ids (at most once), an existing
  continuation, archived or deleted Sessions, a newer activated input or queued input. No
  local table or schema is added. Other devices see the same metadata a crash leaves: the
  Session idle with the input still claimed until this Machine starts again.
- Limits: the conversation shows the `system`-authored `continue` like a human message (no
  distinct label yet). Automatic Inbox batches are not continued. Encrypted workspaces keep
  the send-again failure (Lody cannot sign the requester's intent). An orderly exit before
  the prompt starts is not continued; a crash after the prompt ended but before its
  bookkeeping cleared the claim (at most seconds) is continued once. Remote machines
  continue their own interrupted Turns; scheduled runs continue as their recorded input.
- Executed validation: `apps/cli/src/session/interrupted-turn-continuation.test.ts`
  (detection incl. Machine filter, text, attribution, configuration, at-most-once, user
  wins), `apps/cli/tests/session-execution-service-inbox.test.ts` (shutdown keeps the claim
  of a running prompt and clears that of a finished one) and
  `apps/cli/tests/session-execution-service-turns-part-2.test.ts` (restart dispatch settles
  as stopped and appends one continuation); desktop journeys
  `e2e/src/features/turn-lifecycle.feature` `LODY-TURN-001`..`005` pass, and `LODY-TURN-003`
  (orderly restart) and `LODY-TURN-004` (process-tree SIGKILL) fail with the continuation
  hook disabled.
