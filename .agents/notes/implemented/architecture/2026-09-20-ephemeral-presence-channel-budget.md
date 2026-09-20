# The ephemeral presence channel is a delivery budget, not a data path

Status: implemented
Translation: current

[中文](2026-09-20-ephemeral-presence-channel-budget.zh.md)

## Abstract

A workspace publishes liveness through one ephemeral Loro transport whose queue is
serial, uncoalesced and unbounded, and the machine heartbeat shares it with every other
presence writer. A writer that outruns the network therefore delays the heartbeat, and
because the heartbeat's `updatedAt` is stamped at creation rather than at send, a
delayed one arrives already past the 90s freshness window: readers receive it and still
report the machine offline while the room reports `joined` and no error is raised
anywhere. This change states the resulting obligation as a binding invariant — publish
only small, low-frequency liveness state — and repairs the one live violation found by
an audit of every ephemeral writer.

## Decision

### State the bound as a publisher obligation, not a transport fix

The serial FIFO, the absent coalescing and the unbounded retry budget live in
`@loro-dev/streams-crdt` (`EphemeralStreamCrdt`, inspected at 0.15.1), which this
repository does not control. Waiting for an upstream queue that merges superseded
entries or prioritizes heartbeats would leave every current writer free to reintroduce
the outage, so the bound is stated where it can be enforced today: on the publisher.
`specs/loro-ephemeral-presence-channel.md` records the intent and the reader contract,
and names bounded rate, bounded size, latest-state-only and no-shared-channel-starvation
as the four obligations.

### Place the rule where an agent actually reads it

The invariant is repeated deliberately, at decreasing distance from the code: the Spec
holds intent; `apps/cli/src/lib/loro/AGENTS.md` holds the binding one-paragraph rule;
`.agents/docs/cli-lib-loro-presence.md` holds the routed-out detail and the diagnosis
procedure; and the write boundaries themselves — `LODY_PRESENCE_CHANNEL`,
`CliPresenceRuntime.writeLocalOrigin`, `SessionActivePresenceController.setPhase` —
carry the constraint in their own doc comments, because that is what an agent editing
those files sees first. A new `.claude/skills/lody-loro-sync-stack/SKILL.md` covers the
channel topology for work that starts outside any of those files.

Routing was required, not stylistic: that `AGENTS.md` sat 123 bytes under the 8 KiB gate,
so the presence topic's explanation moved to `.agents/docs/` and left a required-read
trigger behind, per the repository's own remedy for an oversized `AGENTS.md`.

### Dedupe is not a rate limit

`setPhase` skips an identical `(phase, detail)` pair. That guard reads like throttling
and is not: a `detail` carrying a percentage, a counter or a streaming label differs on
every call and publishes at the source's rate. Both the AGENTS.md rule and the method's
own comment now say so, because this is the specific trap that produced the outage and
the violation below.

### Bound the rate at the publisher, not at the presence boundary

`managed-agent-runtime.ts` emitted download progress from a `Transform.transform`
callback — once per stream chunk — and throttled only when the percent was UNCHANGED, so
a changed percent published immediately. A listener republishes those events as session
presence. The fix makes the ceiling purely time-based
(`MANAGED_RUNTIME_PROGRESS_MIN_INTERVAL_MS`, 500ms), so the emit rate is a property of
the publisher rather than of the download. Fixing the source rather than the presence
listener also protects the other consumers of that fan-out, which multiplies per waiting
session. Terminal state cannot be lost, because the caller already forces an emit after
the pipeline settles.

`packages/shared/src/presence.ts` also carried the last unbounded free-text field
(`initializing.detail`); it now takes the same 280-character bound that the reverted
`running.detail` had, so "bounded size" is enforced by schema rather than by convention.

## Audit result

Every ephemeral writer was reviewed. Two channels exist on separate stream URLs and
therefore separate queues: `presence` and `machine-monitor`. Keeping them separate is
load-bearing — machine-monitor snapshots are larger and more frequent than anything the
presence channel may carry, and merging them would put that traffic in front of the
heartbeat.

One live violation was found and fixed (managed-runtime download progress, above).
Three writers remain worth watching and were deliberately NOT changed here, because each
needs its own measurement and a separate scope:

- `workspace-presence-transport.ts` publishes session-viewing on mount and on session
  change with no debounce, and a switch costs a delete plus a set. Rapid keyboard
  navigation can drive it far above a human's switching rate.
- `CliPresenceRuntime.republishLocalState()` loops over every active session on each
  `joined` edge, so a reconnect flap on a many-session machine emits bursts in front of
  the heartbeat it also rewrites.
- `message-handler.ts` publishes an image-generation phase from an ACP-event promise
  chain; it is bounded by `setPhase` dedupe today but sits on an event path.

`local-loro-data-plane-server.ts` already collapses a presence burst into one frame and
snapshots at write time. It is the template for fixing the three above.

### Unknown liveness is not offline

The write side was only half the contract. `getOnlineMachineIds()` returns null when
the presence room could not be joined, which the scoped rules define as status UNKNOWN,
and the MCP server collapsed that null to offline with `?.has(id) === true`. One helper
fanned out to five agent-visible consequences: single-command dispatch and both batch
paths threw `MACHINE_OFFLINE`, the session list reported `temporarily_blocked`, and the
options path silently dropped every remote Machine from the candidate list. The null
branch had no test at all, while `commands/agent-config.ts` already guarded it
correctly and explained why in a comment.

Liveness is now a three-state lookup, and the guards block on a definite `offline`
alone. An unknown Machine proceeds and fails later against its own deadline, which is a
truthful slow failure rather than a fast wrong one — the same position the agent-config
path took. A cold daemon start or a reconnect backoff is enough to make the presence
room unavailable, so this was reachable without any burst.

`lody machine list` had the matching reporting bug: the unknown case existed only in a
stderr warning while stdout said `online: false`, so anything parsing `--json` recorded
a confident offline. `online` keeps its meaning and an additive `onlineStatus` now
carries all three states. `--online-only` still filters on proven-online, which is
correct for that flag, and the warning still fires.

The reverse mapping was deliberately left alone: `session_status_many` derives
`machineOnline` from the live RPC rather than from presence, so it is a different
source and not part of this contract.

## Verification

`managed-agent-runtime.test.ts` pins the ceiling with a frozen clock and 64 delivered
chunks: only the three lifecycle emits survive, and the terminal byte count is still
reported. Ablating the fix back to the percent-based guard turns those 3 into 47, so the
test detects the regression rather than passing silently. Only `Date` is faked; the
download pipeline keeps real I/O scheduling.

Both liveness fixes are pinned by tests that distinguish a Machine absent from a joined
room from one that could not be checked; ablating either collapse fails exactly one of
them. `pnpm --filter lody test` and `pnpm --filter @lody/shared test` cover the presence
schema bound and the unchanged writers. This note records an inspected-source
audit and a deterministic unit-level bound. It is not evidence that the remaining
watch-list writers have been measured under production load, and the live incident that
motivated it was never reproduced end to end under instrumentation.

## Related

The outage that motivated this invariant, and the reverted producer that caused it, are
recorded in
[the rejected transient-reasoning note](../../rejected/bug-fix/2026-09-18-codex-transient-reasoning.md).
