# The renderer creates the Session streams its rooms reach first

Status: implemented
Translation: current

[中文](2026-10-19-renderer-streams-create-missing.zh.md)

## Abstract

After the native Repo and Streams adoption, the first message of a new Session
started in the renderer could stay unuploaded for minutes. Its stream pre-create
runs fire-and-forget on a separate SDK instance, so the room's first bootstrap
can reach the server before the stream exists. The native transport does not
create a missing stream by default, and a 404 at first bootstrap ends the SDK's
initialization while the room still looks like it is connecting, so nothing
repaired it until a wake, network or token event. The renderer transport now
creates a missing stream on join, as the Legacy transport did. A room whose SDK
initialization ended without a retry now also counts as needing reconnect, so
the existing reconnect loop repairs it with its own backoff. That detection is
level-triggered and can take up to the loop's 60-second backstop.

## Symptom

A user starts a Session in a web tab or for a cloud-plane machine. The turn is
written locally and the agent machine is asked to run it, but the Session doc
room never becomes ready: the first turn is not uploaded, and the send path's
upload barrier waits on the room's first sync. Hiding and showing the tab,
going offline and online, a token refresh or a reload repaired it.

## Cause

`startSession` and `createSession` in `lib/session-submission.ts` call
`runtime.ensureDocStream` without awaiting it, by design: a stuck create must not
block accepting the turn. `ensureDocStream` waits for the transport, then creates
the stream through `createRemoteStreamLegacy`, which builds its own SDK stream.
The room's join runs on the room's SDK stream, so its first bootstrap can win.
In Electron, `ensureDocStream` returns early for local-plane Session docs, so the
race mainly affects web tabs and cloud-plane Session docs.

[#1607](https://github.com/LodyAI/Lody/pull/1607) moved the renderer to the
native transport, whose `createStreamIfMissing` defaults to `false`; the Legacy
transport defaulted to `true`. In `@loro-dev/streams-crdt` 0.19.0, a first
bootstrap that answers `stream_not_found` (non-retryable) ends initialization of
that generation: no SDK retry follows and its write loop never uploads the
pending turn. SDK health reports `ready: false` with the non-retryable error,
which `loro-repo` projects as `joining` and the Legacy binding as `connecting`.

The renderer's room tracker flagged only disconnected or failed rooms, so the
reconnect loop, which already repairs this state through `WorkspaceRepoLegacy.reconnect`
and a per-room `syncOnce`, was never scheduled for it. Only forced triggers ran
that repair.

[The CLI fix](2026-10-18-cli-streams-create-missing.md) stated that the
renderer's own Session starts were unaffected. That statement was wrong because
of this race.

## Decision

1. `createWorkspaceStreamsTransport` sets `createStreamIfMissing: true`, so the
   room's first join creates the stream and uploads local state, whoever wins
   the race. It also sets the Code Collab file-index TTL, as the CLI does: the
   renderer joins those Flock rooms, and a stream created without the TTL would
   keep it forever, since the later creator finds it existing.
2. `WorkspaceRoomBinding.initializationFailed` reads SDK health through the same
   predicate that `reconnect` uses to repair a joining room: not ready, no release
   pending, and a non-retryable error or the hard initial-sync deadline. The room
   tracker counts a connecting or reconnecting room with that proof as needing
   reconnect. The local and cloud reconnect loops then repair it on their next
   update, with their existing exponential backoff (1 s doubling to 30 s), and
   reset the backoff only after a healthy dwell.

Consumers of the renderer transport are its Meta room, Session and other doc
rooms, and the named Flock rooms (workspace catalog, machine rows, schedules,
agents, and Code Collab file index). Before #1607 every one of them created a
missing stream, without the file-index TTL. Prompt shortcuts use their own
transport and keep creating only when writing. Protected content is created with
the same SDK create headers as the explicit pre-create.

Rejected alternatives:

- **Await the pre-create before accepting the turn.** A stuck create would then
  block history and dispatch writes, which is why it is fire-and-forget.
- **Project a failed initialization as `error` in the Legacy binding.** The
  status already gives an edge, but the CLI shares that projection and the
  first-sync waiters that read it, and its recovery has its own rules for this
  state.
- **Re-emit the status when the probe changes.** That would send duplicate
  statuses to every binding listener, the CLI's included. The level-triggered
  backstop is enough for a fallback that part 1 makes rare.
- **A retry timer in the tracker.** It would duplicate the loop's backoff and
  its healthy-dwell reset.

Trade-offs: a renderer join of a stream deleted remotely recreates it empty, as
the CLI and the pre-#1607 renderer did. A room that the server refuses
permanently, such as one that fails authorization, now costs one per-room sync
at most every 30 s while the page stays open, plus the idle-store release that
every durable repair already runs. Before, it stayed stuck with no retry.

## Failure containment

The trigger is any non-retryable failure at first bootstrap, or the two-minute
hard initial-sync deadline. Recovery stays with the existing reconnect loops and
their per-room sync; no caller waits, rejects or fences on the new probe. The
base behavior left the room stuck until a forced event. The repair restarts only
that room's SDK generation: a joining room with a pending release is still left
to the SDK. A repair that fails leaves the probe set, so the room stays flagged
and the attempt counts as a backoff step.

## Evidence

- `packages/components/tests/workspace-streams-transport.test.ts` drives the real
  renderer transport and Repo against a byte-level server that answers 404 until
  a stream-level PUT. A Session doc join creates its stream and uploads the turn
  written right after joining; a file-index Flock join creates its stream with
  the TTL. With the old transport both tests failed: the upload barrier rejected
  with `Repository adapter operation failed`.
- In the same suite, a first bootstrap answered with a non-retryable 400 leaves
  the binding `connecting` with `initializationFailed` true, and
  `WorkspaceRepoLegacy.reconnect` repairs it and uploads the earlier write. An
  in-flight bootstrap, and a 503 the SDK retries, keep the probe false.
- `room-sync-tracker.test.ts` and `local-reconnect-loop.test.ts` show the tracker
  flagging the room, and the loop repairing it on its backstop tick with 1 s and
  2 s waits, without an external trigger. Before the change the tracker reported
  no reconnect need and the loop made no attempt.

Not verified: the race against the production Streams service in a real browser.
