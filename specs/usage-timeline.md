# Usage timeline presentation

Status: draft
Translation: current

[中文](usage-timeline.zh.md)

When a user compares the Usage skyline with By model and By member, the same
hourly bucket must describe the same time. All three views use the device time
zone and label bucket starts. The skyline axis follows the returned buckets in
order, including windows that start after midnight. Hourly labels include the
local date and offset where space permits, and midnight is 00:00.

The hourly panel displays the returned window's start and end with dates,
times and local offsets. A bar's tooltip shows its extent clipped to that window,
including partial first and last buckets. The seven-day matrix positions returned
buckets by local date and clock hour, with separate cells for repeated hours.
Clicking a bar or dot opens the explicitly labeled UTC day breakdown for that
bucket. The 30-day and all-time calendars use UTC dates. Desktop and responsive
mobile surfaces share these rules.

Changing ranges closes the selected day breakdown whenever either range is
hourly (24h or 7d). A selection survives 30d ↔ All because those views share the same
calendar cells. Resize and scroll synchronization may move the caret of the
currently selected day; it must not reopen a closed breakdown or replace a
different selection. Clicking a cell after a range change opens its day normally.
Closing a breakdown does not invalidate its cached day snapshot.

The client requests `day` and `week` with `granularity: hour`, then uses the
returned `startMs`, `endMs`, `bucketSizeMs` and buckets. This presentation contract
does not redefine the service's range selection or aggregation. Daily bucket
labels retain the server's label. Values, totals and cost estimates are passed
through; chart alignment provides no evidence about invoice correctness.

## Evidence and limits

- [Queries and response shape](../packages/components/src/components/settings/settings-data-cache.tsx)
- [Local formatting and weekly placement](../packages/components/src/components/settings/usage-timeline-bucket-label.ts)
- [Rendered skyline and matrix regressions](../packages/components/tests/usage-timeline.test.tsx)
- [Cross-day and partial-bucket regressions](../packages/components/tests/usage-share-stats.test.ts)
- [Local display and UTC day identity](../.agents/notes/implemented/feature/2026-11-16-usage-local-time.md)
- [Bucket-start decision](../.agents/notes/implemented/bug-fix/2026-10-01-usage-timeline-time-basis.md)
- [Selection lifetime and callback regressions](../.agents/notes/implemented/bug-fix/2026-10-02-usage-range-selection.md)

The hosted service implementation is outside this public repository. Its range
algorithm, aggregation endpoints and production responses remain unverified.
