# Schedule time

Status: draft
Translation: current

[中文](schedule-time.zh.md)

## Scenario and clock ownership

A person in Singapore schedules work on a machine in Los Angeles. Entering
October 1, 2026 at 02:21 means 02:21 on the selected machine, or 09:21 UTC.
The input and Next runs preview must use that same clock. Product language
controls date and time formatting, independently of the browser's time zone.

The editor uses `MachineMeta.timeZone`; older machines without this metadata
use the viewer's device zone. The preview names the machine and exposes the IANA
zone in its tooltip. Once summaries include the display zone. The list and
proposal summary use the machine zone when available; absent metadata uses the
device zone. An advanced stored cron rule retains its explicit zone.

## Input, switching, and durability

| Rule | Authoring and preview | Saved and executed meaning |
| --- | --- | --- |
| Once | Machine-local date and time | An ISO instant with an offset; execution compares absolute timestamps. |
| Calendar recurrence | Machine-local hour, minute, and calendar fields | Cron expression with an explicit IANA zone. |
| Interval | Machine-clock preview | Elapsed duration from the persisted absolute anchor. |

Changing machines preserves a Once instant and redisplays its date and time on
the new machine clock, including a change of day. Calendar rules keep their
hour and minute and adopt the selected machine zone. Switching Once to a
calendar rule carries its displayed machine-local hour and minute. New weekly
and monthly defaults use today's date on that clock. Switching into Once seeds
an instant one hour after the injected current time. Switching to Manual and
back retains the last timed rule.

Saving an untouched Once field preserves its stored instant verbatim, including
the second occurrence of a repeated DST time. Opening a saved definition must
not reparse its wall-clock display. The Schedule document, Registry fingerprint,
preview, and engine due slot must agree on the same absolute timestamp.

## Daylight saving time

New Once input in a skipped local time moves forward by the DST gap; the field
and preview show the resulting valid local time. Ambiguous input chooses the
earlier instant. For example, Los Angeles `2026-03-08 02:30` resolves to
`03:30` / `10:30Z`, and `2026-11-01 01:30` resolves to `08:30Z`.
Calendar recurrence retains its existing policy: skip nonexistent local slots
and execute the first repeated slot only.

## Evidence and limits

Implementation: [editor](../packages/components/src/components/schedules/schedule-view.tsx),
[time conversion](../packages/shared/src/schedule-recurrence.ts),
[slot evaluation](../packages/shared/src/schedule-time.ts).
Behavioral evidence lives in the existing schedule form, list, recurrence,
zoned-input, repository, and CLI engine suites. These use synthetic documents,
injected clocks, and isolated ledgers. Production task creation, live Agent
execution, and packaged desktop interaction are outside that verification.
