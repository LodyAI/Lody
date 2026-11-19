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
- **One new continuation input.** For each retired execution the CLI admits one new input
  authored by Lody, visible in the conversation, that states the fact: Lody restarted while
  the Agent was working on the previous request. It carries no other instruction
  ([agent-text rule](../AGENTS.md)). The Agent is relaunched the ordinary way
  (`session/load` where supported, otherwise the existing history resume) and receives it.
- **At most once.** A continuation is created only for an execution that was itself started
  by a human or an automation input, never for an interrupted continuation, so a crash
  loop cannot keep restarting work.
- **The user wins.** Stop, a paused Inbox, archive or deletion, or new human input
  accepted before the continuation starts cancel it. The continuation queues behind input
  that is already pending, like any other input.

The owner accepts the risk that an Agent killed mid-action (for example a half-written
file) continues from that state.

## Durability prerequisite

A Session whose input the CLI accepted must still be listed and openable after a hard kill.
Today its metadata (the entry that lists it) is persisted by loro-repo on a 5-second
trailing debounce with no maximum wait, while its history is persisted at once. A SIGKILL
within that window keeps the conversation on disk but loses the entry, so the restarted
desktop shows "This session isn't here" although the CLI reports the interrupted run.
`startSession` intends metadata before history; on disk the order is reversed.

Invariant: a Session's metadata is durable on a replica no later than its first history
write, and before the CLI records acceptance of or dispatches its input. The fix awaits
the repository's immediate metadata persistence at Session creation (renderer, including
fork and child tabs) and before CLI acceptance; a shorter debounce alone only narrows the
window.

## Open questions

- Exact continuation wording and how the conversation labels it.
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
- Validation (failing until implemented): `e2e/src/features/turn-lifecycle.feature`
  `LODY-TURN-003` (orderly restart) and `LODY-TURN-004` (process-tree SIGKILL).
