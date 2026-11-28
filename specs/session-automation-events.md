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

This is a misuse guard, not a consent proof: a program can observe without
depending on the observation. The primitive is honestly a Host-polled one-shot
predicate wait, and routing time-triggered work to Schedules is a product
policy enforced by guidance and the causal budget, not by static or dynamic
analysis of program intent.

**Waits are one-shot slots, superseded by name.** Every registration belongs
to a slot: its `key`, or an unnamed default. Registering into a slot atomically
supersedes that slot's earlier unfinished wait and withdraws its not-yet-started
continuation through the owning Session input owner. Parallel observation is an
explicit opt-in through distinct keys. Exact-match
deduplication remains only as a retry shortcut. One cancel of the current wait
in a slot therefore ends its whole lineage, and rephrasing or re-registering a
task replaces rather than multiplies it. Unkeyed registrations sharing one
default slot is a deliberate behavioral contract: a Session keeps one
outstanding unnamed observation, and genuinely independent parallel waits must
be keyed explicitly.

**Registrations freeze their causal origin, and the budget is enforced.**
A registration records the machine-caused input that produced it: the exact
invoking turn when provenance is available, otherwise the in-flight turn of
the requesting Session, otherwise a human or external root at depth zero.
A continuation input then costs exactly one hop over that frozen depth,
whether it continues a condition wait or a managed run, and target-Session
history never resets it — chronology is not causality. A turn at the causal
cap defined in [Session orchestration](session-orchestration.md) cannot
register new machine-caused work, and a continuation whose frozen depth would
exceed the cap fails durably rather than blocking forever. The same budget
then covers a Session talking to itself through the ledger, Sessions steering
one another, and mixed loops alternating between the two.

**A continuation input announces what it is.** The delivered input opens with
the facts of its origin — the wait, its reason and its registration time — as
reference data, so the agent can distinguish an automation wake from a human
message and a stale continuation cannot masquerade as a fresh instruction. The
prefix carries facts only; it does not direct the agent's work.

**The ledger retires what has ended.** A receipt settles when the input it
delivered settles, regardless of other work the Session group still runs;
delegated outcomes own their own reporting. Cancelling, expiry, failure and
supersession close the registration's internal rule. Archiving or deleting a
Session cancels its unfinished waits. Terminal waits — including a normally
matched wait whose continuation settled — are pruned after a retention window
measured from their terminal settlement, along with their one-shot rules;
receipts remain as inspectable history. Inspection defaults to live rows.

**Supersession is not cancellation.** A slot replacement withdraws a
continuation only while its input has not started; an already-running turn
belongs to the Session owner and completes on its own. Observation ownership
ends where execution ownership begins.

## Guarantees

- Time-triggered work always passes through the human-confirmed Schedule
  surface. Registration accepts no recurring, delayed or clock-only condition,
  and no mechanism in the automation layer re-arms a completed wait.
- One slot holds at most one unfinished wait. A user who redirects the task
  never leaves the previous watcher running in parallel, and cancelling the
  visible wait cancels the lineage behind it.
- Every machine-caused input advances one shared causal budget, whatever
  transport delivered it; only human-caused work restarts at the root. The
  cap is enforced both at registration and at continuation admission, so an
  unattended loop through any combination of ledger and message channel
  reaches `CHAIN_DEPTH_EXCEEDED` within the same fixed hop count, and the
  refusal is a durable failure rather than a retrying block.
- A continuation whose wait was superseded or cancelled before its input
  started never reaches the Session; one already running is not undone.
- The count of live waits, rules and visible notes for one Session stays
  bounded by its live slots plus the retention window; receipts and events
  remain as inspectable audit history, one entry per continuation actually
  delivered, rather than expiring on a clock.
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
