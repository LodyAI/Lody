# Presence, not a one-shot RPC probe, decides whether a target Machine is offline

Status: implemented
Translation: current

PR: [#1939](https://github.com/LodyAI/Lody/pull/1939); status shape and unjoined-room
reads: this branch's PR (`fix/streams-reconnect-presence-flap`)

[中文](2026-10-27-mcp-chat-machine-probe-timeout.zh.md)

## Abstract

`lody_session_chat` rejected chats to Machines that presence reported online with a
permanent `COMMAND_REJECTED: Machine … is offline or unavailable.` whenever a one-shot
Loro Streams status RPC timed out during a short transport slowdown;
`session_status_many` reported the same Machine as offline. The remote branch of that
probe is removed. Session create, chat and cancel, and both status readers, now treat a
remote target as offline only when presence definitively says so, and raise that
case as a typed retryable `MACHINE_OFFLINE`. Unknown presence proceeds, and an RPC
timeout during a status read only makes the live status stale; the batch status shape
carries all three states so an unanswered RPC cannot turn unknown into offline. A fresh
heartbeat already in the replica proves online even while the presence room is not
joined. Permission, ownership, archive and existence checks are unchanged.

## Cause

`ensureTargetMachineOnline` opened a fresh Streams RPC client for every remote target
and sent `requestMachineStatus({ timeoutMs: 10_000 })`. A timeout returned `null`, which
the code reported with the same message as an explicit failure. In the MCP chat paths,
that plain `Error` matched no mapper and became `COMMAND_REJECTED` with
`retryable: false` (batch: `INVALID_ITEM`). In status reads, it made `machineOnline`
false before the live-status RPC ran. Field evidence: the caller's own Streams
connection took about 29 s to reconnect at that moment, while presence and a later
retry of the identical request both showed the target online.

## Decision

The probe guarded nothing that its callers needed:

- Create and chat deliver through the synced Session document. The dispatch RPC after
  the write is already a best-effort fast path, and the Coordinator retries
  materialization until the Operation deadline.
- Cancel and status send their own RPC (`requestSessionCancel`,
  `requestSessionLiveStatus`) immediately afterwards, and that RPC reports
  unreachability by itself.

`ensureTargetMachineNotOffline` therefore keeps the non-RPC checks:

- the session-command-environment workspace/machine match;
- the local daemon check for same-machine targets, which preserves
  `DAEMON_NOT_RUNNING` and `DAEMON_BUSY`.

For remote targets it reads three-state presence and throws `MachineOfflineError`
only for definite offline.

For status reads, presence decides the Machine state. When presence is unknown, an
answered live-status RPC upgrades it to online, and an unanswered one leaves it
unknown. Correction: the batch reader first returned a `machineOnline` boolean, which
turned unknown presence plus an RPC timeout into offline, so `session_status_many`
still answered `temporarily_blocked / MACHINE_OFFLINE` for a healthy Machine. The batch
item now carries `machinePresence`, and MCP reports `machine.state: unknown` with chat
allowed. The single CLI `session status` reader keeps its boolean, meaning proven online.

Presence itself is read the same way. `getMachinePresenceView` returns the Machines with
a fresh heartbeat in the replica and `synced`, whether the room is joined now. The SDK
(`streams-crdt` 0.19.2) reports one status for both directions: every live-read recycle
and any failed local POST leaves `joined` while received heartbeats stay valid until
they expire. A fresh heartbeat is therefore online without a joined room; absence is
offline only when `synced`, as the presence Spec requires. Alternatives considered: a
grace window after leaving `joined`, rejected because it would report offline from a
room that is not synced; patching the SDK to expose the read-side status, deferred
because it changes a pinned dependency and does not remove the need for three states.

In MCP, `MachineOfflineError` keeps its retryable `MACHINE_OFFLINE` code before
acceptance, in both single and batch chat. When it occurs while delivering an
accepted single chat, the tool returns the active Operation for daemon replay, as
create and batch chat already do.

Alternative considered: keep the probe but reclassify timeouts as a retryable
`MACHINE_UNREACHABLE`. Rejected because it keeps a slow token/gateway/stream setup in
front of every call, and still makes callers retry work that the durable path
already owns.

## Scope and limits

Human CLI `session create/chat/cancel` now fail fast only on presence offline. A
remote Machine that is online in presence but unreachable is discovered by the cancel
RPC, or by eventual delivery. MCP `session_create` already skipped this check before
acceptance, and is unchanged. Tests use injected presence and a rejecting RPC stub
(`daemon-session-tools.test.ts` pins all three `session_status_many` outcomes); no
end-to-end reproduction of the Streams slowdown was run. The trigger that keeps a daemon's
own room unjoined for minutes is not established: its presence diagnostics were
discarded until this branch bound early scoped loggers to the daemon file sink.
