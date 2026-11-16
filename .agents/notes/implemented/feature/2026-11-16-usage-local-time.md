# Device time for hourly usage charts

Status: implemented
Translation: current

[中文](2026-11-16-usage-local-time.zh.md)

## Abstract

Users compare hourly usage with activity on their own clock. The interactive
24-hour and seven-day charts use the device time zone for the same bucket
starts. The service owns daily aggregation and exposes UTC day keys, which
the calendar and day breakdown identify explicitly.

## Decision

The [bucket-start decision](../bug-fix/2026-10-01-usage-timeline-time-basis.md)
keeps chart labels aligned. Place each returned week bucket by its local start
date and hour, and preserve both buckets when a clock hour repeats. The offset
in each tooltip distinguishes their timestamps. A click derives the UTC day
key from the original timestamp. Changing that key to the local date would
retrieve a different aggregate for buckets crossing midnight.

## Verification

The [browser suite](../../../../packages/components/tests/e2e/usage-timeline.spec.ts)
covers all three charts and the UTC drill-down with a Singapore device clock.
The [timeline suite](../../../../packages/components/tests/usage-timeline.test.tsx)
covers placement through a repeated hour. Both use synthetic data.
