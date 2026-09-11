# Session goal control

Status: draft
Translation: pending

A goal is a standing objective attached to a session: the agent keeps working
toward it across several turns without the user re-asking. Codex is the first
agent to implement one. This Spec covers how a person starts, pauses, resumes,
and clears that goal, and what Lody guarantees while it runs.

## Scenario

Someone gives a session a goal and walks away. The agent works, finishes a turn,
decides on its own that the objective is not met, and starts another. Twenty
minutes later the person opens the session, sees the goal banner, and presses
**Pause**. They read the transcript, then press **Resume**.

Both presses must take effect. That is the whole requirement, and it is not free:
while a goal is active it owns the session's only ACP prompt, and ACP v1 has no
second prompt to spare.

## Responsibilities

**The agent** owns goal state and scheduling. It decides when to continue, and
it publishes a snapshot — objective, status, usage — after every change. Lody
never infers goal status from turn activity.

**Lody's CLI** owns turn attribution. Every unit of agent work must belong to a
conversation entry the user can see, cancel, and read later. Nothing else in the
product may create agent work outside that rule.

**The UI** owns intent only. It shows what the agent published and asks for
actions the agent advertised; it never decides how an action is delivered.

## Two transports, one reason

A goal action either changes durable state or starts work, and ACP v1 treats
those very differently.

`pause` and `clear` change state and nothing else. They travel out of band, as an
ACP extension request, and they work while a prompt is running. This is the
property that makes them useful at all: the prompt they need to interrupt is the
goal's own prompt, so an action that waited for a free prompt slot would wait for
the thing it is trying to stop.

`set` and `resume` start work. A client can only own running work through its own
prompt, so Lody opens one and carries the action in its metadata. The agent
applies the action, adopts any turn it started natively, and keeps that prompt
open for the goal's remaining turns. The action never appears as user-visible
command text.

This is the button transport, not a replacement for typed commands. Users can
still enter `/goal xxx` (and the supported `/goal` subcommands) through the
ordinary chat path. Both entrances use the agent's same goal state and scheduler.

An agent advertises which actions it supports and which transport carries each.
Lody offers exactly the advertised actions, for any agent — goal control is not
Codex-specific product behavior, only Codex-first availability.

## Guarantees

- An active goal never suppresses turn completion or its notification.
- A published goal status is authoritative for what the goal will do next. It is
  not a statement about whether a turn is running right now: a paused goal may
  still be draining its final turn.
- `pause` and `clear` are delivered without waiting for a turn. If the session
  has no live agent, they fall back to the turn path, which starts the agent and
  uses its advertised prompt transport even if it also advertises requests.
- `resume` and `set` never run concurrently with another turn. When one is
  running, the action waits for it and then executes; it is not dropped and does
  not require the user to stop the session first. Only the newest queued action
  survives, so a stale pause cannot undo a later resume. A newer out-of-band
  Pause/Clear or a valid Stop also discards any goal action not yet submitted.
- Work-starting button requests acknowledge acceptance as `queued`, without
  waiting for the persistent prompt to finish or claiming that execution already
  started. Startup failures appear through the session's normal failure history;
  an accepted action must not disappear merely because several turns ran first.
- A goal turn creates an assistant entry and no user message. It carries no run
  configuration, so resuming a goal cannot silently change model or mode.
- Stopping a session cancels the turn first and then pauses the goal, so Stop
  stays immediate. The agent also pauses a goal whose prompt it cancelled, which
  is what closes the window between the two.
- Every goal action is a machine RPC subject to the same session access
  verification as a chat message.

## Unresolved

Only Codex implements the goal extension today, so the neutral contract has one
producer. Whether other agents will express a comparable objective loop, and
whether `set` deserves a first-class UI beyond the `/goal` command, are open.

## Evidence

Intended behavior: this document.

Inspected implementation: `packages/acp-extension-core` (`LodyGoalCapability`,
`LodyGoalPromptControl`), the Codex adapter's goal extension and its
`docs/goal-extension.md`, `apps/cli/src/agent/goal-control.ts`,
`SessionExecutionService.controlSessionGoal`, and
`packages/components/src/components/sessions/session-goal-control.ts`.

Executed validation: adapter tests for the prompt-metadata transport, CLI tests
for transport selection and for queueing a resume behind a draining turn, and
component tests for capability-driven command availability. Host regressions cover
prompt-lifetime-independent acceptance, more than three competing turns,
supersession before provider submission, rewrite-barrier release, and visible startup
failures. Agent-client wire tests cover cold pause/clear and unchanged manual `/goal xxx`
prompts. No live Codex goal was exercised end to end.
