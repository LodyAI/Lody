# Scheduled automation

`CLAUDE.md` is a symlink to this file.

- Schedule definitions live in `schedule-<id>` Loro docs. The workspace `:sr`
  Flock Registry is the execution gate. A definition must match its published
  fingerprint; existence discovery must never republish or enable an orphan.
- `schedule-workspace.ts` owns subscriptions, clock wakeups and target facts;
  `schedule-engine.ts` owns serialized planning and handoff; `schedule-store.ts`
  owns the Host-local SQLite ledger. Cursor advancement and a run intent share
  an IMMEDIATE transaction. Preserve cursor/run ids across restarts.
- Session history goes through `sessionData` (`readSessionHistory` reads,
  `commands.appendTurn` appends missing entries); there is no whole-list rewrite.
- Freeze JSON `PreparedSessionInput` before Session mutation. Its fixed user turn
  uses `prepared`, inert until `latestUserMsgId` is committed. After this pointer,
  the ordinary watcher owns execution. Never retry with another Session or Turn,
  reset Session status/title, or unwind a committed dispatch.
- A disconnected cloud Registry blocks new handoffs. `schedule-sync-gate.ts`
  requires the initial and current connection sync; a previously resolved
  first-sync promise is insufficient after reconnect. Pure local bypasses only
  this cloud gate, never ownership/config validation.
- `AgentExecutionSlots` is host-local, per-Agent-config Schedule admission.
  Restore accepted occupancy before evaluating; retain it while Session
  dispatch, queues, Operations or deliveries still have work. Release before
  prehandoff retry.
- Configuration unavailability is recoverable without consuming an attempt.
  Infrastructure failures use bounded backoff; all prehandoff work expires after
  its fixed dispatch age. Only unprepared pending automatic runs may be superseded.
- The command service is transport-neutral. Local CLI/MCP uses the authenticated
  user's private daemon socket; cloud one-shot commands use their workspace repo.
  Official MCP has list/show/propose/pause only and is registered for every
  Agent session; the service re-checks that the caller owns the invoking
  Session on this machine. A proposal takes effect only after the person
  confirms its card. Human commands are not a security boundary against an Agent with shell access.
  `propose` takes a NAMED rule (`ScheduleProposalRuleSchema`), never cron, and
  validates it as a trigger before writing; it publishes one idempotent
  `schedule_proposal` system notice per `requestId` through
  `schedule-proposal.ts` and reports the person's outcome on a repeated call.
  The tool description tells the agent to ask rather than guess when the
  prompt, rule or destination is unclear — that guidance is the product
  behaviour, so keep it in step with what the card can resolve.
- Permission validation uses ACP `_permission` category or advertised legacy
  modes, never option-id spelling. No credentials or provider exception content
  may be written to Registry runtime rows or Schedule logs.
- `definition.project` is OPTIONAL. Absent means a chat-only run: no local-project
  ledger lookup, no `project` on the resolved target, and `buildProjectOptions`
  contributes nothing to the prepared Session. A project that IS set is still
  validated against the owning machine's Flock before handoff. Never substitute a
  default project for an absent one. `schedule-session-preparation.test.ts` calls
  the PRODUCTION `prepareSessionInput` for this — an `ownerTarget` bypasses
  project resolution, so only that path proves the resulting `SessionMeta`
  carries no `project`, `repoFullName` or `baseBranch`.
- A `manual` trigger is never due and has no next slot; only a Registry manual
  request plans it. `definition.destination` chooses the Session: `new_session`
  derives one per run, `own_session` derives ONE from schedule id + epoch, and
  `existing_session` is the person's chosen chat. `scheduleRunIds` is the single
  place that decides this; turn and source ids stay unique per run. Before
  handoff, `destinationSessionProblem` requires a shared chat to be absent (owned
  only) or the owner's, on this machine, driven by this Agent — the exact fields
  `materializePreparedSessionInput` refuses to change — and reports
  `SESSION_UNAVAILABLE` as a recoverable configuration problem. The command
  service applies the same rule on create/edit and rejects a project on a
  schedule that sends into a chat.
- Dispose Schedule workers before tearing down a workspace's Lody runtime.
  Timers and active evaluations must not survive workspace revocation.
- Deterministic tests use injected clocks, explicit sync barriers and temporary
  SQLite files. Do not add wall-clock sleep or live-provider timing assertions.
