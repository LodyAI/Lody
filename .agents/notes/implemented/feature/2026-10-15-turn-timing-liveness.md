# Turn timing and liveness in the conversation

Status: implemented
Translation: current
Date: 2026-10-15
Language: English
Other language: [中文](2026-10-15-turn-timing-liveness.zh.md)

## Abstract

A running assistant turn showed how long it had worked, but not whether anything
was still arriving. Users could not tell a long command run from a stuck turn.
The turn-configuration popover now shows when the turn started and how long it
has run or took. For a turn that presence reports as running, it also shows how
long ago this device last received live output, with a weak warning after 60
seconds. The live status line adds "no output for N m" after two minutes of
silence. The time is an in-memory stamp on the renderer, so history, its schema,
the sync protocol and the `endedAt` rule are unchanged. A time is shown only for
output received while the device stayed in live sync. Otherwise the row states
why there is none: catching up, disconnected, or waiting on the user.

## Request

PR: [#1589](https://github.com/LodyAI/Lody/pull/1589).

A community user (Discord thread "More Detailed Turn Information") wanted to
check a turn that seemed to be running a `local_bash` lint gate. They needed its
start time and the time of its last history update to judge whether it was busy
or stuck.

## Decision

- **Start, end and duration come from existing fields.** The start is
  `startedAt` when it is recorded, otherwise `timestamp`; older entries carry
  only `timestamp`. The running time and the finished duration reuse
  `resolveLiveSessionHistoryDurationMs` and `resolveSessionHistoryDurationMs`.
  Both are the "Worked for" measure, so the popover and the status line cannot
  disagree. Instants use the user's local time zone. Today's instants show the
  time with seconds; other days add the date, and other years add the year. The
  hover text is the full date and time, including the time zone.
- **The update time is a renderer stamp, not stored data.** `endedAt` is
  written once at finalization, and an open turn is identified by its absence
  (#260): moving it while a turn streams would change finished-turn semantics.
  Persisting a separate time would add one document write per streamed delta,
  and Roost history carries only a revision, no wall-clock time. Instead,
  `ConversationView.lastUpdateAt` records when the backend reported a history
  change. Loro and Roost share that reader path. Roost's live notifications are
  driven by `roostHistoryCursor` in the same session room, so no extra
  subscription is needed. Opening, hydration and paging do not move the stamp,
  and it does not bump `version`: consumers read it on their own clock tick.
- **Presence decides whether a turn is running.** Running time and liveness
  appear only when the newest unfinished turn's session has presence, the same
  signal as the Working label. A turn whose daemon died before finalizing stays
  unfinished in history forever. It shows only its start, never "running 3d" or
  a fresh-looking update.
- **Only output received inside a live window counts.** The session page turns
  the room sync state and browser connectivity into `live`, `syncing` or
  `offline`. `useHistoryLiveWindow` opens a new window each time the state
  becomes `live`: on opening, switching back and reconnecting. A stamp earlier
  than the window's start plus `LIVE_SYNC_SETTLE_MS` (one second) is treated as
  the catch-up batch and shown as `—`. A session viewed long after it stalled
  therefore never looks fresh.
- **No time means a stated reason.** The row says "Disconnected" in the warning
  tone when this device is offline, "Waiting for you" (no warning) while the
  agent waits on a permission decision, and `—` while catching up or before the
  first live output. Only a received update shows an age.
- **Thresholds are constants.** `TURN_LAST_UPDATE_STALE_MS` (60 seconds) colors
  the age with the warning tone. Its tooltip says the agent may be running a
  long command or may be stuck. `TURN_SILENCE_NOTICE_MS` (2 minutes) adds "no
  output for N m" to the status line, in whole minutes so it does not change
  every second. The suffix never appears while waiting on the user, offline, or
  before live output. It states the silence without a warning tone, because a
  long command can legitimately stay silent.

## Alternatives considered

- **Refresh `endedAt` while streaming.** Rejected: it breaks the finalize-once
  rule and the meaning that `canAppendAssistantDeltas` and "Worked for" rely on.
- **Write a `lastUpdateAt` field into history.** Rejected: it means a write for
  every delta plus a schema change. It would also measure the writer's activity,
  not what this client received.
- **Use Loro change timestamps.** Rejected for now: Roost has no equivalent, and
  writer-side timestamps would bring cross-machine clock skew. The renderer
  stamp compares two readings of the same local clock.
- **Gate liveness on the history `finished` flag.** Rejected after review: an
  unfinalized turn would report itself as running indefinitely.

## Limits

- Local writes, such as answering a permission or sending a steer message, also
  move the stamp. The backend change notification does not carry its origin.
  The effect is a warning up to a minute late.
- A device that has just entered live sync shows `—` until the next output
  arrives, even for a turn that is genuinely streaming.
- A turn that waited on permission still shows a high live duration until
  finalization. This gap belongs to the live-duration label: see
  [desktop live turn duration](2026-09-17-desktop-live-turn-duration.md).

## Verification

`packages/components/tests/assistant-turn-timing.test.ts` covers:

- the row facts for running, finished, unfinalized and missing-field turns, and
  the `startedAt` fallback;
- each liveness state, including that a catch-up batch never counts;
- the live-sync mapping and the silence threshold;
- clock formatting across local midnight and years, with a fixed time zone.

`tests/conversation-view-from-reader.test.ts` checks the stamp against real Loro
storage: it stays `null` through opening and range hydration, and only a
history write moves it.

`tests/agent-activity-row.test.tsx` renders the real stream with fake clock and
interval timers. It covers:

- the "no output for 4m" status, and its absence while waiting on the user;
- the running popover before and after the warning threshold;
- a catch-up import around entering live sync;
- the waiting and disconnected states;
- an unfinalized turn with no presence, and the finished popover;
- `useHistoryLiveWindow` reopening its window on reconnect.

`AssistantTurnAlignment.stories.tsx` provides `DesktopTurnTimingLive` and
`DesktopTurnTimingFinished` for visual review. Neither a real stalled daemon, a
real network loss, nor a live Roost session was reproduced.
