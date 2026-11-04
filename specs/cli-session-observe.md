# CLI Session observation

Status: draft
Translation: current

[中文](cli-session-observe.zh.md)

## Scenario and responsibility

A terminal program dispatches a turn without waiting, then attaches to the Session
to inspect its outcome and follow later work. Observation reads the same Session
facts as Lody; it does not execute, acknowledge unread messages, answer permission
requests, or control the Session lifecycle. This increment uses the existing Cloud
CLI authentication and Streams path. Local-only daemon attachment is not supported.

```sh
lody session observe <sessionId> --jsonl --follow
lody session observe --workspace <selector> --all --jsonl --follow
lody session observe <sessionId> --json
```

Without `--follow`, return a snapshot and exit. Follow requires `--jsonl`.
`--json` and `--jsonl` are mutually exclusive. A single Session may fall back to
`LODY_SESSION_ID`; `--all` requires an explicit workspace, rejects a positional
Session ID and ignores that environment variable. Workspace selectors accept ID,
slug or name. There is no offline follow or automatic stale-cache fallback.

## JSONL contract, version 1

Every successful stream event includes `version: 1`, `streamId`, `sequence`,
`observedAt` (Unix milliseconds) and `workspaceId`. Sequence starts at 1 and orders
one command process across its Sessions. It is not a durable cursor, cross-process
identity, timestamp of the original execution, or replay guarantee.

| Type              | Payload and meaning                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `snapshot`        | `sessionId`, `session`: baseline for a newly observed source.                                   |
| `ready`           | Optional `sessionId`: initial single-Session read or workspace catalog enumeration is complete. |
| `session.changed` | `sessionId`, `session`: a meaningful projected state changed.                                   |
| `turn.started`    | `sessionId`, `userTurnId`, optional `assistantTurnId`: observed transition to running.          |
| `turn.finished`   | Same identities plus `outcome: completed \| failed \| canceled`, optional `durationMs`.         |
| `session.removed` | `sessionId`: metadata confirms deletion. Archive is a change, not removal.                      |

`session` contains `sessionId`, `machineId`, optional `title`, `archived`, `state`,
`freshness`, `source`, optional `latestTurn`, and `activeTurns`. Session state is
`idle | pending | running | waiting | unknown`. Each turn includes `userTurnId`,
optional `assistantTurnId`, `state: pending | running | unknown | completed | failed | canceled`,
and optional `durationMs` for a terminal turn with an Assistant (0 when timing is unavailable).

```json
{
  "type": "snapshot",
  "version": 1,
  "streamId": "example",
  "sequence": 1,
  "observedAt": 1791417600000,
  "workspaceId": "w1",
  "sessionId": "s1",
  "session": {
    "sessionId": "s1",
    "machineId": "m1",
    "archived": false,
    "state": "idle",
    "freshness": "synced",
    "source": "persisted",
    "latestTurn": { "userTurnId": "u1", "assistantTurnId": "a1", "state": "completed" },
    "activeTurns": []
  }
}
```

Snapshots carry the latest turn outcome even when attachment happens after a fast
completion. Existing historical turns establish a baseline; they do not produce
replayed `turn.started` or `turn.finished` events. A turn can finish without an
observed start when it completes between reads. Explicit reopening of an Assistant
can produce another running/finished transition for the same IDs.

`--json` returns `{ok: true, version: 1, workspaceId, session}` for a single Session
or `{ok: true, version: 1, workspaceId, sessions}` for a workspace catalog.
Diagnostics go to stderr during structured observation. Command failures retain
the existing CLI error format: JSONL `{type: "error", error: "..."}` without the
versioned envelope, or JSON `{ok: false, error: "..."}`, followed by nonzero exit.
Consumers must handle errors and process exit as well as successful events.

## Evidence and freshness

Completion requires User `handled` and a linked Assistant with `finished: true`
or numeric `endedAt`. User `failed` or `canceled` independently proves those
outcomes, including failure before an Assistant exists. An idle metadata status,
cancel acknowledgement, missing Presence or disconnected machine proves no turn
outcome. When metadata's `latestUserMsgId` or `processingUserMsgId` points to a
turn not yet confirmed terminal in history, the previous turn's result cannot
make the Session idle or release its workspace subscription.
`waiting` means persisted permission-wait status while a turn is running;
it does not expose permission payloads or answer them.

`source: persisted` means history directory scalars and control state were read.
`source: metadata` is a cheap catalog projection, always with `state: unknown` and
no turn proof. `freshness: synced` refers to the confirmed read, not daemon liveness
or a guarantee that every room remains connected. For an attached history room,
loss of its connection changes freshness to `unavailable`, retaining prior turn
state and suppressing terminal events. Confirmed metadata/document catch-up restores
freshness and reconciles outcomes. Initial sync failure or unrecoverable read error
fails the command; it is never converted to completion or deletion.

## Workspace cost and observation limits

One process and one metadata watch discover Sessions, including archived metadata.
The watch is installed before listing, and changes arriving during enumeration
are reconciled before catalog `ready`. That marker does not mean every history
room has opened: consumers inspect `source` on each Session snapshot.

Historical idle rooms remain unopened. Follow opens active/pending candidates,
new Sessions and Sessions with a changed latest-turn identity, with at most four
concurrent document opens. This bounds acquisition concurrency, not the number of
simultaneously active Sessions. A room remains held until fresh durable terminal
evidence is read; then only observation-owned resources are released. Catalog
edits retain its last observed outcome. Historical body-only edits and arbitrary
reopening without an activation metadata change in an unopened idle room are
outside workspace follow's scope; attach to that Session for continued observation.
One-shot workspace output is the metadata catalog and does not open history rooms.

Ordinary streaming text/tool output produces no per-token event. Incremental
scalar reads, serialized refreshes and projection comparison coalesce changes.
This is observation of persisted facts, not a lossless runtime event log. After
restart or a gap, inspect snapshots/history and maintain any required event buffer
in the consuming program. Existing `create/chat --wait --jsonl` and finite
`history --jsonl` formats remain unchanged.

SIGINT/SIGTERM stop following and release subscriptions without canceling execution.
Deleting a single observed Session also ends its follow; workspace follow continues.
Output is ordered and waits for backpressure, with a 1 MiB queued-output bound.
A broken pipe or source error ends observation and triggers cleanup.

## Evidence and validation limits

- [Command and process ownership](../apps/cli/src/commands/AGENTS.md).
- [Projection, incremental reads and writer](../apps/cli/src/commands/session-observe.ts),
  [scoped adapter](../apps/cli/src/commands/session-observe-runtime.ts), and
  [workspace catalog](../apps/cli/src/commands/session-observe-workspace.ts).
- [Deterministic event tests](../apps/cli/src/commands/session-observe.test.ts) and
  [real persisted read-only document test](../apps/cli/src/commands/session-observe-runtime.test.ts).
- [Implementation decision](../.agents/notes/implemented/feature/2026-10-08-cli-session-observe.md).

Focused tests cover event semantics, races, buffering, teardown and read-only
opening. Real authenticated CLI/provider execution and external Connector
interoperability have not been validated. This translated Spec remains a draft.
