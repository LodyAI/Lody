# The Loro ephemeral presence channel

Status: draft
Translation: current

[中文](loro-ephemeral-presence-channel.zh.md)

A workspace publishes liveness over a Loro ephemeral channel that is separate from durable
document synchronization: machine heartbeats, active-session status, and "who is viewing this
session". Readers decide that a machine is online only from a heartbeat whose `updatedAt` is
inside the freshness window. Durable conversation content travels on its own transport and is
unaffected by anything below.

## The channel is a liveness budget, not a data path

The ephemeral channel is latest-state oriented. It is not persisted with the document stream,
it replays no history, and a server may keep only a small live fan-out queue and disconnect a
slow subscriber instead of buffering every intermediate update. Everything published on it is
therefore disposable, and the only reason to publish is that some reader needs to know the
current state right now.

One workspace owns ONE ephemeral transport, and machine heartbeats share it with every other
ephemeral writer in that workspace. Publication is strictly serial: one update is in flight at
a time, the rest wait in a first-in-first-out queue that does not merge superseded entries,
does not prioritize heartbeats, and has no length bound. A writer that produces faster than the
network drains therefore delays every LATER writer, including the heartbeat, for as long as the
backlog lasts.

That delay corrupts liveness rather than merely slowing it. A heartbeat's timestamp is taken
when the entry is created, not when it is sent, so an entry that waits longer than the freshness
window arrives already expired: readers receive it and still classify the machine as offline.
The connection reports itself healthy throughout, because a backlog draining successfully is not
an error, so no reconnect or recovery path observes the problem.

## Invariant

**Publish only small, low-frequency liveness state on the ephemeral channel. Never publish
high-frequency or high-volume data on it.**

Concretely, for every ephemeral writer:

- **Bounded rate.** A writer is driven by a timer, a state transition, or a user-visible phase
  change — never by each element of a stream. Per-chunk, per-token, per-keystroke, per-frame and
  per-loop-iteration publication are all prohibited, however small one payload is. When a
  high-rate source must surface, sample or throttle it to a fixed ceiling before it reaches the
  channel, so the publication rate is a property of the publisher rather than of the source.
- **Bounded size.** A payload is a small fixed-shape record whose every field has a schema bound.
  Unbounded strings, accumulated text, file contents, diffs, transcripts, encoded documents and
  collections that grow with a session are not liveness state and do not belong here.
- **Latest-state only.** A writer publishes current state under a stable key and tolerates losing
  every intermediate value. Anything a reader must receive in order, or must not miss, is durable
  data and belongs on the document transport.
- **No shared-channel starvation.** Adding a writer is a change to the machine heartbeat's
  delivery budget, because they share one queue. A new ephemeral writer states its worst-case
  rate and payload size, not its typical one.

A feature that does not fit these bounds is not made to fit by shrinking one payload. It belongs
on the durable document transport, or it stays local and is never published at all.

## Consequences for readers

Reading liveness stays a three-state question. A fresh heartbeat means online; the absence of one
on a synced transport means offline; an unsynced transport means unknown. A reader must not
report "offline" from an unsynced transport, and must not treat a healthy connection as evidence
that delivery is current — the failure this spec prevents produced exactly that combination.

The three states must survive to the consumer, not be flattened on the way. Only a definite
offline may block work or refuse a dispatch; unknown proceeds and fails later against its own
deadline, because a truthful slow failure beats a fast wrong one. A surface that reports liveness
carries the state itself rather than a boolean, so a caller can tell "we checked and it is down"
from "we could not check".

## Evidence

Channel constants, payload schemas and the freshness predicate are in
`packages/shared/src/presence.ts`. The workspace transport, its two stores and the machine
heartbeat timer are in `apps/cli/src/lib/loro/presence.ts`; session active presence has a single
owner in `apps/cli/src/lib/loro/session-active-presence.ts`. Reader-side interpretation is in
`packages/components/src/atoms/presence.ts` and, for the CLI, in
`apps/cli/src/commands/machine.ts`, whose `onlineStatus` carries the three states through
`--json`. The MCP dispatch guards in `apps/cli/src/mcp/lody-mcp-server.ts` block on a definite
offline only; `apps/cli/src/commands/agent-config.ts` takes the same position.

The serial queue, its lack of coalescing and the unbounded retry budget are implementation
details of `@loro-dev/streams-crdt` (`EphemeralStreamCrdt`), inspected at version 0.15.1. This
repository does not control them, which is why the bound is stated as a publisher obligation.

The failure this spec prevents was observed on 2026-09-20 and is recorded in
[the rejected transient-reasoning note](../.agents/notes/rejected/bug-fix/2026-09-18-codex-transient-reasoning.md):
one session published a presence update per agent reasoning chunk, producing 4,000 writes in
three seconds, after which that workspace's machine read as offline while conversation sync
stayed healthy. This draft records the intended constraint. It is not evidence that every
existing writer has been measured under production load.
