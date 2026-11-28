# Session automation events

Status: draft
Translation: current

[中文](session-automation-events.zh.md)

## Scenario

An agent finishes its turn while part of the work still depends on the outside
world: CI has not reported, a deployment is not ready, delegated Sessions are
still running, or a long command has not exited. The user expects the
conversation to continue exactly when the state they care about changes, not
on a timer.

Because each wait completes once, an agent that must "keep checking" can today
only re-register a fresh wait after every wake. Observed in real use, that
chain pattern re-registers dozens of times per task, fills the ledger with
dead one-shot rows, floods busy Sessions with queued continuations whose
instructions are stale by the time they run, and — when the wake text drives
cross-session coordination — produces unattended message storms that the
causal depth limit cannot see, because ledger-delivered inputs carry no depth
at all.

## Decision

**Automations perceive state transitions; time only schedules observation.**
A wait exists to detect a change the Host cannot know in advance: an external
state flip, or the exit of a managed process. The clock is never an event. A
person who wants the agent woken every N minutes, or once at a chosen time,
uses a Schedule, which keeps its human confirmation and pause controls. Lody
does not offer recurring or delayed wake-ups through automation registration,
and agent guidance must route periodic and delayed requests there instead.

**A wake is never produced without observation.** An evaluation that returns a
result without performing any observation through `ctx.read`, `ctx.fetch` or
`ctx.exec` is invalid: it can only encode a clock comparison or a constant,
neither of which is information. The wait fails at that evaluation rather than
completing. An evaluation that observes and answers `false` costs no agent
wake at all, so observation polling stays with the Host.

**Waits are one-shot slots, superseded by name.** Every registration belongs
to a slot: its `key`, or an unnamed default. Registering into a slot atomically
supersedes that slot's earlier unfinished wait and withdraws its not-yet-started
continuation through the owning Session input owner. Parallel observation is an
explicit opt-in through distinct keys. Exact-match
deduplication remains only as a retry shortcut. One cancel of the current wait
in a slot therefore ends its whole lineage, and rephrasing or re-registering a
task replaces rather than multiplies it.

**Automation continuations join the causal chain.** A continuation delivered to
a Session is a machine-caused input like any other: it advances the causal
depth defined in [Session orchestration](session-orchestration.md) by one over
the turn that preceded it, whether it continues a condition wait or a managed
run, and only a human input resets that count. The same budget then covers a
Session talking to itself through the ledger, Sessions steering one another,
and mixed loops alternating between the two, because depth is derived from the
causal record rather than from the transport that delivered the input.

**A continuation input announces what it is.** The delivered input opens with
the facts of its origin — the wait, its reason and its registration time — as
reference data, so the agent can distinguish an automation wake from a human
message and a stale continuation cannot masquerade as a fresh instruction. The
prefix carries facts only; it does not direct the agent's work.

**The ledger retires what has ended.** A receipt settles when the input it
delivered settles, regardless of other work the Session group still runs;
delegated outcomes own their own reporting. Cancelling, expiry, failure and
supersession close the registration's internal rule. Archiving or deleting a
Session cancels its unfinished waits. Terminal rows are pruned after a
retention window, and inspection defaults to live rows.

## Guarantees

- Time-triggered work always passes through the human-confirmed Schedule
  surface. Registration accepts no recurring, delayed or clock-only condition,
  and no mechanism in the automation layer re-arms a completed wait.
- One slot holds at most one unfinished wait. A user who redirects the task
  never leaves the previous watcher running in parallel, and cancelling the
  visible wait cancels the lineage behind it.
- Every machine-caused input advances one shared causal budget, whatever
  transport delivered it; no medium resets it except a human input. An
  unattended loop through any combination of ledger and message channel
  reaches `CHAIN_DEPTH_EXCEEDED` within the same fixed hop count.
- A continuation whose wait was superseded or cancelled before its input
  started never reaches the Session; one already running is not undone.
- The count of ledger rows and visible notes for one Session stays bounded by
  its live slots plus the retention window, however long the workspace lives.
- Ledger privacy, frozen grants, admission rechecks, Stop semantics and the
  match-is-final contract are unchanged.

## Open questions

- The retention window for terminal rows (proposed: 48 hours) is a starting
  value awaiting review.
- `lody_schedule` requires an explicit `sessionId` for `existing_session`; a
  `current` shorthand would remove the last friction that pushes agents toward
  ledger timers when the user asks for periodic checks in this conversation.
  That is a Schedule-surface change, separable from this Spec.
- Whether cross-session chat originating from automation-driven turns should
  queue rather than steer into a busy target is a question about
  `lody_session_chat` semantics in general, not about automation, and is
  deliberately not answered here.

## Evidence

- Implementation under change: registration and deduplication in
  `apps/cli/src/automations/storage/ledger.ts`, evaluation in
  `apps/cli/src/automations/runtime/engine.ts` and
  `apps/cli/src/automations/programs/codemode.ts`, continuation preparation in
  `apps/cli/src/automations/actions/session-actions-legacy.ts`.
- Rationale, field evidence and rejected alternatives:
  [design note](../.agents/notes/implemented/architecture/2026-11-28-session-automation-event-perception.md).
- Incident reports: [LodyAI/Lody#3477](https://github.com/LodyAI/Lody/issues/3477)
  and its cross-session follow-up comment.
- Module behavior contract: [automation README](../apps/cli/src/automations/README.md).
