# Keep the landing selection through presence churn

Status: implemented
Translation: current

[中文](2026-11-05-landing-selection-presence-churn.zh.md)

## Abstract

A remote machine chosen on the chat landing was replaced by the local machine, and
stayed replaced after the remote returned. Two faults combined. A presence restart
delivered an empty snapshot while the remote was alive, and the landing treated any
absence from the online set as a reason to re-resolve and persist the selection. A
restart now keeps the last snapshot until the new room joins, and liveness moves a
selection only once, at startup, without touching stored defaults. The cost is that a
machine which really goes offline stays selected until the user changes it.

## Problem

`useChatLandingDefaults` re-resolved from `selectableMachines`, which contains the
local machine plus machines with a fresh heartbeat. It ignored the three-state rule in
[the presence channel budget](../architecture/2026-09-20-ephemeral-presence-channel-budget.md):
an unsynced room read as offline. Web had no visible symptom on an empty set, because
that effect returns when nothing is selectable, while desktop always has the local
machine to fall to. The persist effect then overwrote the remembered target, so one
empty frame was permanent.

An in-place SSE recycle retains the store and was never the cause. The empty frame
came from store replacement: the join watchdog after 20 seconds in `connecting` or
`reconnecting`, and the reconnect loop's `stop()` then `start()` on `error`,
`disconnected`, or a stale wake. The SDK folds read and write into one status, so a
failing POST can restart a room whose read side is healthy. A heartbeat older than the
TTL on a synced room also removes one machine, and no restart is involved there.

## Decision

- `WorkspacePresenceTransport` withholds replacement-store snapshots until `joined`.
  `stop({ retainSnapshot: true })` is used only by the two reconnect loops. Every other
  stop still delivers `{}`. A first `start()` delivers as before.
- After a landing mount settles liveness, an existing selection is never replaced for
  liveness alone. Removal of the machine or its config still re-resolves.
- A stored machine that a synced room reports offline at startup falls back for that
  view. The remembered target stays in defaults and returns when selectable, unless
  the user picks something else first.
- Only a definite `offline` blocks send. `unknown` proceeds to the machine's deadline.

## Alternatives

- **Follow liveness but restore on return.** The owner rejected it: a stale heartbeat
  on a synced room would still swap the target under the user mid-composition, and a
  chat could start on the wrong machine without them noticing.
- **Only skip the fallback while unsynced.** This misses the stale-heartbeat path.
- **Only fix the landing.** Sidebar pills, session status and machine-scoped sync would
  still blink on each restart, so the empty frame had to go at its source.

## Consequences

Retained entries can outlive their room by up to the 90-second TTL when a restart
never joins. That matches what an in-place reconnect already showed, and the sync
state stays `connecting`, so a missing machine reads as `unknown`. Why this client
restarts its room in the reported case is not established: no field trace was
available, so the fix removes the symptom without proving the trigger.

## Verification

Component tests cover snapshot continuity across the watchdog and reconnect-loop
paths, the terminal clear, both reconnect-loop wirings' `retainSnapshot` argument for
cloud and dual modes, selection survival, the startup fallback and its return, and the
send-blocking state. Not verified in a live desktop session with a real remote machine.

PR: [#2342](https://github.com/LodyAI/Lody/pull/2342).
