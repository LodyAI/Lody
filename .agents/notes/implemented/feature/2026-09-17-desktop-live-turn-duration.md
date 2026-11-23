# Desktop shows the live assistant turn duration

Status: implemented
Translation: current

[中文](2026-09-17-desktop-live-turn-duration.zh.md)

## Abstract

The desktop conversation footer previously showed a turn duration only after the
assistant had finished, leaving no visible indication of how long a running
agent had been working. The existing turn timestamp and live duration resolver
already provided the correct anchor, so the desktop footer now mounts the same
live label used by mobile for the latest unfinished assistant turn. The footer
stays visible while that turn runs and updates through the shared stable clock;
unfinished turns that are no longer current remain empty and do not keep a
timer subscription.

## Decision

The duration is derived from the assistant turn's `timestamp`, using
`resolveLiveSessionHistoryDurationMs` with the current sampled time. This keeps
the live and finished labels on one time definition and avoids using presence or
session metadata as a second, less precise clock. `isLive` remains a structural
row flag set only for the latest unfinished assistant turn, so an abandoned
older turn cannot continue displaying an elapsed value after a newer turn is
created.

The desktop footer uses the existing action-bar status channel. It is visible
while live, displays `Worked for ...` after the action controls, and leaves the
existing completed-turn timestamp and duration behavior unchanged. The footer
render gate explicitly accepts a live turn, including one with no copy handler,
so the duration does not depend on an unrelated action being available.

## Verification

`packages/components/tests/assistant-turn-action-inset.test.ts` renders the real
desktop footer with fake timers and verifies `Worked for 5s` advances to
`Worked for 7s`, the live action bar remains visible, and a stale unfinished
turn renders neither the live label nor an action bar.
`packages/components/tests/chat-virtual-rows-identity.test.ts` verifies that the
real row builder creates the live footer without a copy handler and removes it
when that unfinished turn is displaced. The existing resolver and mobile tests
continue to cover the shared calculation and ticker behavior.

The three targeted suites pass (24 tests), as do the components typecheck,
scoped Oxfmt check, and documentation check. Before saving the branch, root
`pnpm check` and `pnpm format` were attempted but could not start because
`corepack` is unavailable; these are not recorded as passing full-workspace gates.

The permission-wait accounting limit documented by the
[mobile live-duration decision](2026-09-14-mobile-live-turn-duration.md) still
applies: the running history entry does not publish the wait total until
finalization, so a turn that pauses for permission can step down when it ends.
