# Detach a failed Session instance before its cleanup terminate

Status: implemented
Translation: pending

## Abstract

A session restored after idle GC lost an entire turn of agent output when the ACP
resume attempt failed and the execution service fell back to a history-replay
session. `SessionManager` registers a `Session` instance's lifecycle events before
`createAgent`, so the cleanup `terminate` of the failed instance published
`terminated` as if the live turn's agent had died; `MessageHandler` finalized the
turn, and every update from the replacement agent was dropped without a target.
The manager now detaches the instance from its listeners and the live map before
that terminate, so lifecycle events publish only for instances a caller received.
The trade-off is that a startup crash no longer triggers the `exit`-driven idle
status write; the rejected `createSession` promise is the sole signal and the
caller owns recovery.

## Problem

Observed on 2026-09-11 in two dsh (`@deepseek-ai/dsh-acp-demo@0.1.1-rc.2`)
sessions on the same machine. dsh advertises neither `loadSession` nor `resume`,
so any continuation after the idle GC evicts the agent takes this path:

1. `createSessionInnerWithAgent` calls `createSessionInner`, which constructs the
   `Session`, calls `registerSessionEvents`, and stores it in `sessions`.
2. `createAgent` throws `[ACP_RESUME_UNSUPPORTED]`. The catch block calls
   `session.terminate(true)`, which emits `terminated`.
3. The manager forwards it. `MessageHandler`'s `terminated` listener runs
   `finalizeACPState`, which clears the transient turn state to `idle` and stamps
   the assistant entry finished.
4. `SessionExecutionService` catches the resume error and, by design, creates a
   fresh session with a replay prompt. `activateTurnACPUpdateTarget` is a no-op on
   an idle turn, so `enqueueACPUpdate` logged
   `Dropping ACP update without an active/finalized assistant entry target` for
   34,551 thought chunks and 48 message chunks over six minutes.
5. The prompt resolved `completed`; the turn was recorded through
   `recordSilentTurnFailure`. The agent's own transcript held the full answer.

The defect is independent of dsh: any agent whose resume fails would lose the
fallback's output. dsh's missing `loadSession` is a capability gap that only
degrades context after GC; it caused no loss.

## Decision

Fix at the source of the spurious event rather than downstream:

- `registerSessionEvents` keeps its handlers and stores a per-instance detacher in
  a `WeakMap`. The `createAgent` catch block calls `detachSession(session)` before
  `terminate(true)`: listeners are removed and the instance is dropped from
  `sessions` only if it is still the mapped instance for that id. The identity
  check matters because a recovery path may already be creating the replacement
  under the same session id.

Alternatives considered:

- Re-`beginTurn` in the execution service's fallback path. Rejected: the handler's
  `terminated` listener is fire-and-forget and clears turn state in a `finally`
  after `waitUntilSynced`, so it can land after the replacement prompt started and
  wipe a live turn; it also stamps `finished` on the entry and registers a late
  update target that would then need undoing.
- Guard in `MessageHandler`'s listener. Rejected: the event carries only a session
  id, so the handler cannot distinguish the turn's bound instance from one that
  never prompted without new plumbing across three layers.

## Verification

`apps/cli/src/session/session-manager.test.ts` drives the public `createSession`
with a custom ACP launch and `Session.prototype.createAgent` rejecting with
`[ACP_RESUME_UNSUPPORTED]`: no `terminated`/`exit` reaches manager consumers, the
session is absent from the map, and a replacement created under the same id is the
mapped instance whose later `terminateSession` does publish `terminated`.

Not verified: an end-to-end restore against a real agent that lacks resume, and
the `SessionExecutionService` fallback path itself, whose behavior is unchanged.
