# Machine Flock remote catch-up retries and reports its failures

Status: implemented
Translation: current

[中文](2026-09-22-machine-flock-remote-sync-retry.zh.md)

## Abstract

A teammate's shared machine could appear in the machine list while its Agent
list stayed empty. The renderer reads each machine's agents from that machine's
`<workspaceId>:mf:<machineId>` Flock stream. When joining the stream or its first
remote sync failed, the error was swallowed: nothing was logged, nothing was
reported, and nothing retried. The effect then skipped the unchanged task, so the
machine kept only whatever the local replica already held — nothing, for a machine
this device had never synced — until a remount or a presence flip. A failed
catch-up now releases its room lease, retries on exponential backoff (1s doubling
to 60s) for as long as the consumer is mounted, logs a `console.warn`, and emits
one `machine_flock/remote_sync_failed` PostHog event per machine until a catch-up
succeeds. It does not change which machines are fetched: offline or `unknown`
machines are still read from the local replica only.

## Problem

`useMachineFlockRowsByMachineIdsState` (`packages/components/src/hooks/use-machine-flock-rows.ts`)
reads local rows first, then, for machines in `remoteMachineIds`, joins a shared
room and waits for `firstSyncedWithRemote` before publishing remote rows. The
remote attempt ended in `.catch(() => undefined)`. A rejected join removes the
shared room, but the task stayed current with the same `workKey`, and the effect
`continue`s past such a task. No path re-ran the attempt.

A rejection can come from a network blip, an expired stream token, or the hosted
service refusing the stream. The last can't be verified from this repository.
Because every failure was silent, none of these showed up in logs or analytics.

## Decision

- On failure the task drops this attempt's lease immediately. That way a dead
  room isn't kept alive for reuse, and the retry's `acquireMachineFlockRoom`
  joins afresh once no holder remains.
- Retry delay is deterministic `min(1000 * 2^(n-1), 60000)` ms, with no jitter.
  Each mounted consumer retries on its own; joins and syncs are already
  deduplicated per room and per doc. Unmount, a runtime switch, or the machine
  leaving the remote allowlist cancels the pending timer through the task's
  cleanup.
- Reporting is deduplicated per `workspaceId + machineId` across consumers until
  a successful catch-up clears it. The first failure logs `console.warn` and
  captures the event. Later ones log `console.debug` only, so a machine whose
  stream is refused doesn't report once per consumer every minute.
- The event carries only low-cardinality fields: `workspace_id`, `machine_id`,
  `families`, `error_type`, `http_status` (when the error exposes `status` or
  `statusCode`), and `navigator.onLine`. The error message is not sent, because
  transport errors can embed stream URLs. PostHog `error`/`message` keys are
  on the denylist anyway. The desktop build's telemetry stays hard-disabled by
  the platform capability, so this only reports where PostHog is configured.

## Alternatives considered

- Remembering a failed first sync on the shared room and making later leases run
  a fresh `syncOnce` catch-up. It was dropped: every holder awaits the same first
  sync and now releases on failure, so a failed room doesn't outlive its holders.
  The flag would have been untested defense.
- `captureException` with the raw error. It groups better in PostHog error
  tracking, but it would ship the unfiltered message.

## Verification

`packages/components/tests/use-machine-flock-rows.test.tsx`:

- Two join failures (the first a 403) followed by success. The test checks for
  exactly one report carrying `http_status: 403`, a second attempt after 1s, and
  the agent row published after the 2s retry. It fails against the previous
  source.
- Unmount after a failure. The test checks that no further join happens once 60s
  of fake time pass.

The related component suites (31 files, 306 tests) pass. The underlying rejection
seen in production has not been reproduced here, so whether it's transient or a
hosted authorization refusal is still open. The new event is meant to answer that.

## Not changed

Remote catch-up is still gated on presence. A visible machine that reads offline
or `unknown` never has its stream fetched. Relaxing that gate is a separate
decision.
