# Schedule Registry load failure diagnosis

Status: implemented
Translation: current

[中文](2026-10-27-schedule-registry-load-recovery.zh.md)

## Abstract

The schedule list used to collapse local document failures and remote first-sync failures into one load error, clearing already readable tasks without offering retry. The workspace hook now preserves readable rows with a warning and retries acquisition three times, after 1, 3 and 10 seconds. Network restoration and an explicit Retry action can also restart acquisition. Empty local scans wait for first-sync confirmation; the underlying network cause and packaged recovery remain unverified.

## Evidence and scope

Before this fix, at revision `51669978e28995629a33e01338fe16796caa3db9`,
[`useScheduleRegistrySync`](../../../../packages/components/src/hooks/use-schedules.ts)
opens the workspace's `:sr` Flock document, subscribes, and publishes its local
scan before joining the room and awaiting `firstSyncedWithRemote`. Any rejection
replaces the snapshot with empty rows and `REGISTRY_UNAVAILABLE`, discarding the
original error. [`ScheduleListView`](../../../../packages/components/src/components/schedules/schedule-list.tsx)
then hides the rows and displays the generic load error.

The hook was mounted by the workspace shell. Opening the list again did not restart
it when the runtime identity stays unchanged. A later Flock update can clear the
error, but the hook did not actively retry failed acquisition or first sync.
These are source-proven behavior findings, not proof of a specific network cause.

A remote first-sync rejection reaches the same generic load-error branch even
when the local document is readable. A successful read from another replica does
not establish the failed renderer's freshness or the cause of its transport error.
Tests use synthetic tasks and controlled failures; no captured logs or account
identifiers are included.

## Recovery behavior and validation

- Record the failing stage (open, scan, join, first sync), room identifier and
  sanitized error through existing client diagnostics. Do not log row contents.
- Keep local read failure distinct from remote sync failure. Preserve readable
  rows with an explicit freshness warning; an unsynced empty scan must not claim
  authoritative absence. Preserve execution and write admission checks from the
  [machine-owned scheduling decision](../../implemented/feature/2026-09-24-machine-owned-scheduled-tasks.md).
- Provide three timed retries and an explicit retry action, with one active acquisition
  per workspace hook. Dispose retired subscriptions and fence late results on
  workspace change. A failed first join may require rejoining, not just reconnecting.
- Use the existing [readiness binding selector](../../../../packages/components/src/lib/room-readiness.ts)
  when awaiting a room routed to multiple transports. This is a separate source
  compatibility concern, not the established cause of the observed network error.
- Tests validate a readable nonempty snapshot followed by first-sync rejection, a cold
  open rejection followed by successful retry, an unsynced empty scan, and a
  workspace switch while acquisition is pending. Drive failures and recovery with
  explicit signals and fake timers; verify a packaged client separately.

The shell owns acquisition; list consumers only request a retry through an atom.
Remote failure releases only the room before scheduling another join. The readable
local document and its Flock subscription remain live even after retry exhaustion,
so successful local pause, delete and create operations keep updating the list.
Releasing both subscriptions would freeze the list after retry exhaustion despite
later successful local mutations, as verified by a controlled reproduction.
Initial local scan failure still releases
the unusable observer and reopens on retry. Successful first sync clears the warning;
a local change alone neither clears it nor marks an inactive retry as running.
Workspace replacement or unmount cancels timers and ignores late results, including
unsubscribing a room whose join completes after retirement. No extra execution or
write admission bypass is introduced. The React hook remains ordinary React code;
this change does not introduce an Effect service or change runtime ownership.

```text
workspace shell -> open + local scan -> join + selected first sync -> live updates
remote failure -> retain local observer + warning -> release room -> retry join
workspace change / unmount -> cancel timers + subscriptions; fence late results
```

Behavioral coverage includes automatic recovery, local pause/delete/create after
retry exhaustion followed by manual recovery, local scan failure and recovery,
online restoration, cold empty scans, late open/join/sync after
workspace change, and visible saved rows plus the Retry control. Storybook covers
empty failure, saved-row sync failure and retry in progress. Packaged desktop
behavior still needs separate verification; no release or deployment is claimed.
