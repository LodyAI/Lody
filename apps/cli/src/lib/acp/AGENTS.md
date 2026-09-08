# apps/cli/src/lib/acp — ACP notification → session history

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Root `AGENTS.md`, `apps/cli/AGENTS.md`, and `../AGENTS.md` also apply.

`history.ts` owns `handleACPUpdateMessage`, per-toolCallId enrichment, and
edit-evidence extraction; `history-apply.ts` owns the CRDT history writes. Protocol
reference: `context/acp-protocol.md`; per-agent payload quirks:
`context/acp-agent-edit-evidence.md`.

## Ownership is bound at enqueue time

ACP updates must be bound to assistant-entry ownership when they are enqueued, never
by asking for "the current turn" during flush. `../session-transient-store.ts` stores
`assistantEntryId` / `userTurnId` / `turnEpoch` on each buffered update, and
`history.ts` exposes explicit assistant-entry versus autonomous append APIs. It must
not silently create uuid entries for unowned output; that is what prevents
bad-network retry tails and duplicate dispatch from rendering the same agent turn
twice.

## Scheduling tools are the one `rawInput`/`rawOutput` exception

INVARIANT: `history-apply.ts` strips `rawInput`/`rawOutput` from ALL generic tool
calls (they are unstructured by spec) EXCEPT the four scheduling tools in
`SCHEDULING_TOOL_NAMES` (`CronCreate` / `CronDelete` / `CronList` / `ScheduleWakeup`,
matched via `_meta.lody.toolName`). For those, the small `rawInput`/`rawOutput` are
kept, the persisted `title` is pinned to the canonical tool name, and
`schedulingTimeZone` is recorded — this machine's IANA zone, captured at persist time,
because cron is local-time to it and the panel must resolve fire times in that zone via
`nextCronFireMs` rather than the viewer's browser zone. Also retain `recordedAtMs`,
the first-persisted wall-clock sighting: cron-fire steers extend the turn's `endedAt`
past a one-shot fire minute, so using it as the creation anchor can roll the fire to
next year. For one-shot crons, prefer the output's `nextFireAt` over any anchor.

This is what lets the web derive its "session will continue" panel from the
Cron/ScheduleWakeup `tool_call` items in history: the CLI persists NO extra
scheduled-task state, neither in `SessionMeta` nor as a new history item. See
`@lody/shared` `collectPendingScheduledTasksFromHistory` and `nextCronFireMs`. The
deriver reads exactly those fields — do not "clean up" this exception, or the panel
goes silently empty (unit tests fabricate history and will not catch it).

The former `_meta.claudeCode.toolName` carrier is read only by the centralized
one-release compatibility path; new provider output must use the Core contract.

## Flush, evidence, and shutdown

These bind `../message-handler.ts` and `../session-transient-store.ts`, which drive
this pipeline. Flush retries retain notification-level progress and cached
rich-content materialization — never re-upload an attachment after only its history
write failed — stop after a bounded backoff budget, and carry the enqueue-time turn id
into Code Collab evidence. Evidence arriving for a finalized target is serialized
through the same per-turn persistence chain as normal finalization; a failed attempt
restores both captured evidence sets ahead of concurrently collected evidence and
schedules bounded, evidence-only backoff retries that never replay the
already-persisted ACP history update.

Shutdown order: cancel those timers, stop SessionManager producers while keeping
workspace documents open, wait for already-started async evidence collectors, flush
ACP/evidence, then close stores. Never close a store or take the final map/chain
snapshot while agent callbacks or tracked evidence collectors can still populate turn
evidence. Permanent deletion blocks new ACP enqueue, waits for an already-started
flush, and drops retry state before deleting the session doc, so a late retry cannot
recreate deleted data.

The finalized-turn late-ACP routing target in `../session-transient-store.ts` does NOT
expire by wall-clock time: agent sessions stay alive and emit events long after
`stopReason` (cron, `ScheduleWakeup`, deferred work), and those must still reach the
Loro doc. Clear it only when a new turn owns ACP updates (normally `beginTurn()`, but
visible dispatch defers until prompt start) or on replay suppression.

Turn-scoped history LIST writes in `../message-handler.ts` (assistant entry creation,
ACP/proposed-plan flushes, finalization, chat_failed notices, image-group entries) must
first `await awaitTurnHistoryGate(sessionId)` — see
`../../session/turn-history-gate.ts`. Add the same await to any NEW code path that
appends or positions history entries during a turn; map-keyed status/meta writes stay
ungated.
