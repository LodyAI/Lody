# Steer any queued row, and invert the busy-send route with one shortcut

Status: implemented
Translation: current

[中文](2026-09-18-per-row-queue-steer-and-inverted-send.zh.md)

## Abstract

Two steering affordances that previously required workarounds are now direct:
Cmd+Shift+Enter in the composer inverts the configured busy-send behavior for
that one submission (a queue default steers, a steer default queues), and every
queued row — not only the first — offers Steer while the agent advertises
native acknowledged steering. Both reuse the existing guide route and
per-item steer handler; the only new logic is an `invertBehavior` input in the
submit-route resolver and a per-row visibility gate. A rejected steer still
degrades to an ordinary next turn through the CLI's proven-non-delivery
promotion, so an inverted send can never lose the message. The remaining
trade-off: a non-first item whose steer degrades runs ahead of the queue head,
which mirrors what the user asked for ("send this one now") but is an implicit
reorder worth documenting.

## Problem and decision

Two gaps sat in front of already-built machinery:

- **Busy-send routing was global-only.** `queuedMessageBehavior` chooses queue
  vs. steer for every busy send; a user who keeps the queue default had no way
  to steer one message without changing settings. The resolver already owned
  `forceQueue`/`forceDirect` overrides, so the missing piece was a per-send
  "invert" that flips the configured behavior before the same guards run.
  Cmd+Shift+Enter now sets `invertBehavior` (Shift alone stays newline;
  Mod alone stays unbound). Steering still requires positive live prompt
  activity and a known unfinished assistant turn, so the shortcut degrades to
  the ordinary route when nothing is steerable.
- **The Steer row action was first-item-only** (`isFirst &&`), even though the
  native path promotes by `$cid`/`userTurnId` and never consults position. The
  gate existed because the fallback — interrupt-and-send — only cancels the
  active turn and lets the CLI promote the queue head: on a non-first row it
  would dispatch the WRONG item. Rows now split by capability
  (`shouldShowQueuedItemSteer`): with authoritative `acknowledgedSteer` every
  row offers Steer; without it only the first row does, where the fallback is
  semantically correct.

A defensive guard in `handleSteerQueuedMessage` keeps the same rule if a
non-first item ever reaches the handler without native steering.

## Alternatives considered

- For non-first rows without native steer: auto "reorder-to-first → sync →
  interrupt" (internalizing today's manual flow), or "remove item + append
  pending history + dispatch" (bypassing the queue). Rejected for now: both
  add a second data path for a capability that is absent anyway; hiding the
  action is honest about what the agent can do. Revisit if users ask for
  interrupt-and-send on arbitrary rows.
- Binding the shortcut to "force steer" instead of "invert default" was
  rejected: inversion covers both directions with one binding and matches the
  already-plumbed `forceQueue` precedent.
- Showing non-first Steer disabled instead of hidden was rejected: the queue
  already renders `showSteerAction` conditionally, and a disabled button
  invites a "why can't I" question with no useful answer.

## Limits and verification

- An inverted steer (or a non-first row steer) that the adapter rejects —
  `unsupported`, `stale-turn`, config mismatch — is promoted to an ordinary
  pending turn and runs BEFORE the queue head. That is the explicit
  "send this now" intent, but it silently overtakes earlier queued items.
- The shortcut has no visible affordance yet (send-button tooltip/shortcut
  help could add it later); drafts ignore it since drafts cannot steer.
- Verified by unit tests on the route resolver and the row-gate predicate
  plus type-checking; no live-agent steering was exercised.

## Evidence

- `packages/components/src/components/sessions/session-message-submit-route.ts`
- `packages/components/src/components/sessions/session-chat-input-area.tsx`
- `packages/components/src/components/sessions/message-queue/{queued-message-steer,message-queue-row,message-queue-display,AGENTS.md}`
- `packages/components/tests/{session-message-submit-route,queued-message-steer}.test.ts`
- Related: [steer stop and recovery ownership](../bug-fix/2026-09-16-steer-stop-recovery-ownership.md),
  [interrupt pending input exactly once](../bug-fix/2026-09-14-interrupt-pending-input-exactly-once.md)
