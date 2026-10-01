# Once schedules use one machine clock

Status: implemented
Translation: current

[中文](2026-10-01-schedule-once-clock.zh.md)

PR: https://github.com/LodyAI/Lody/pull/1197

## Abstract

Once input converted the selected machine's wall time into an absolute instant,
but its preview and summary displayed that instant in the viewer's zone. Switching
Once to a calendar rule also copied the viewer's hour and minute, changing the
intended execution time. Display and conversion now receive the machine clock
explicitly, while persistence continues to preserve absolute Once instants.
DST input resolves gaps forward and folds to the earlier occurrence; verification
uses isolated fixtures rather than production schedules.

## Decision and evidence

This corrects implementation gaps in the
[machine-owned schedule decision](../feature/2026-09-24-machine-owned-scheduled-tasks.md).
The [time Spec](../../../../specs/schedule-time.md) records the complete current
input, switching, persistence, and execution contract as a draft.

At main `7d502f3d99fdcdbbdd43d032c6d903d4ed497e04`, `triggerTimeZone` and
`describeRecurrence` used the device zone for Once, while the datetime input used
the machine zone. `timeOfDayOf` used native local Date getters when switching
from Once. The two-pass offset conversion oscillated around a spring DST gap and
returned the earlier wall time, contradicting its stated forward policy.

The editor passes the selected zone to preview formatting and kind conversion.
List context carries machine timezone metadata to both frequency and next run;
proposal summaries use their resolved machine zone. Once summaries name that zone.
Weekly/monthly defaults use the selected clock's current calendar date. DST
conversion samples offsets on both sides of the local date, chooses the earliest
exact candidate in a fold, and the later candidate in a gap.

```text
machine-local input → absolute Once instant → Schedule document / Registry
                                      ├→ machine-local preview and summary
                                      └→ engine due slot / isolated SQLite ledger
```

Preserving Once wall time when changing machines would retime an existing
absolute commitment. Keeping the instant and redisplaying it matches the existing
stored contract and avoids migration. Periodic rules retain wall time when the
target changes. Entering Once retains the existing one-hour seed. No persisted
schema or execution policy is replaced.

## Verification and limits

Existing suites cover same/different viewer and machine zones, date boundaries,
typed input versus preview and saved trigger, machine changes, form reopen,
Once/calendar/Manual transitions, DST gaps/folds, untouched second-fold instants,
Loro snapshot restore with a stable Registry fingerprint, and engine ledger slots.
The main form/conversion replay produced seven expected regression failures.
The final focused run passed 84 tests; the UI/shared suites also passed all 72
tests with the viewer zone set to Los Angeles instead of Singapore.

On base `93545f01b69cb0c98ddd3f19d46540decd95a007`,
`NODE_OPTIONS=--no-experimental-webstorage NODE_ENV=test pnpm run check` passed,
including 4,601 component, 1,269 shared, and 3,298 CLI tests, plus Electron and
other workspace suites. The existing CLI/RPC suites skipped seven tests.
Node 26.10's default global Web Storage caused the unrelated boot-shell storage
fixture to fail; disabling that experimental feature only for the check process
made its 19 tests pass without product changes. `pnpm run format`, targeted
Oxfmt verification, and `pnpm run docs check --base origin/main` passed.

The original production hour difference is not reconstructed from a captured
account or transcript. The Los Angeles/Singapore fixture has a 15-hour offset
on October 1; the reported 9-hour display difference alone cannot establish the
production browser zone or saved timestamp. Machine discovery only confirmed
availability and Schedule protocol support. No production tasks were created,
and packaged desktop and live-provider execution remain unverified.
