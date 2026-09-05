# Scheduled automation

`CLAUDE.md` is a symlink to this file.

- Schedule definitions live in `schedule-<id>` Loro docs. The workspace `:sr`
  Flock Registry is the execution gate. A definition must match its published
  fingerprint; existence discovery must never republish or enable an orphan.
- `schedule-workspace.ts` owns subscriptions, clock wakeups and target facts;
  `schedule-engine.ts` owns serialized planning and handoff; `schedule-store.ts`
  owns the Host-local SQLite ledger. Cursor advancement and a run intent share
  an IMMEDIATE transaction. Preserve cursor/run ids across restarts.
- Freeze JSON `PreparedSessionInput` before Session mutation. Its fixed user turn
  uses `prepared`, inert until `latestUserMsgId` is committed. After this pointer,
  the ordinary watcher owns execution. Never retry with another Session or Turn,
  reset Session status/title, or unwind a committed dispatch.
- A disconnected cloud Registry blocks new handoffs. `schedule-sync-gate.ts`
  requires the initial and current connection sync; a previously resolved
  first-sync promise is insufficient after reconnect. Pure local bypasses only
  this cloud gate, never ownership/config validation.
- `AgentExecutionSlots` is shared with delegated Task automation. Restore accepted
  Schedule occupancy before starting Task automation; retain it while Session
  dispatch, queues, Operations or deliveries still have work. Release before
  prehandoff retry. Task release must not trigger its own immediate failed retry.
- Configuration unavailability is recoverable without consuming an attempt.
  Infrastructure failures use bounded backoff; all prehandoff work expires after
  its fixed dispatch age. Only unprepared pending automatic runs may be superseded.
- The command service is transport-neutral. Local CLI/MCP uses the authenticated
  user's private daemon socket; cloud one-shot commands use their workspace repo.
  Official MCP has list/show/propose/pause only, with the invoking owner and
  driving turn's `scheduleToolsEnabled` checked again by the service. Human
  commands are not a security boundary against an Agent with shell access.
- Permission validation uses ACP `_permission` category or advertised legacy
  modes, never option-id spelling. No credentials or provider exception content
  may be written to Registry runtime rows or Schedule logs.
- Dispose Task/Schedule workers before tearing down a workspace's Lody runtime.
  Timers and active evaluations must not survive workspace revocation.
- Deterministic tests use injected clocks, explicit sync barriers and temporary
  SQLite files. Do not add wall-clock sleep or live-provider timing assertions.
