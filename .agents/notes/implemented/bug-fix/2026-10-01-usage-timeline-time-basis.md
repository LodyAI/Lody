# Usage chart time basis

Status: implemented
Translation: current
PR: [#1196](https://github.com/LodyAI/Lody/pull/1196)

[中文](2026-10-01-usage-timeline-time-basis.zh.md)

## Abstract

The Usage page labelled the skyline's columns as fixed UTC hours while its split
charts labelled local bucket ends, placing the same activity under different
times. The client now uses UTC bucket starts, a timestamp-derived skyline axis
and the returned window's full endpoints. It also retains the eighth UTC date
when a seven-day window starts after midnight. This fixes presentation using
synthetic data; hosted aggregation and real invoices remain unverified.

## Evidence and decision

Main `7d502f3d99fdcdbbdd43d032c6d903d4ed497e04` still contained both conventions.
The related PR search found no effective fix; closed PR #32 concerned range-aware
skyline rendering, not this time basis. Both chart families consume the same
cached timeline. The public query requests hour granularity for day/week and
exposes the range endpoints and bucket size, but contains no service implementation.
The final main refresh, `93545f01b69cb0c98ddd3f19d46540decd95a007`, changes only
GitHub policy recovery; the usage implementation is unchanged.

A synthetic UTC 23:00 bucket appeared as 08:00 in UTC+08, and a partial final
00:00 bucket appeared as 08:17. An added regression failed on the old code even
with a UTC formatter: 23:00 became 00:00. This establishes a label defect, not
lost tokens or incorrect cost totals.

UTC was chosen over converting the calendar to each viewer's local time because
the calendar and day-detail identity are already UTC. Returning to local labels
would require a different day query contract. Bucket starts preserve the actual
timestamp identity; using ends alone shifts complete buckets and makes the last
partial bucket a special case. Dates and explicit UTC resolve midnight ambiguity;
tooltips preserve partial extents. The mobile surface now passes its selected
timeline to the same visualization.

Current behavior belongs to the [timeline Spec](../../../../specs/usage-timeline.md).
The [day-cache decision](2026-09-21-usage-detail-cache.md) and
[share-image decision](../feature/2026-09-09-usage-share-image.md) remain applicable.
Share image rendering is outside this page-alignment change.

## Verification

The owning statistics suite tests UTC starts, cross-day axes, partial extents and
daily label preservation. The rendering suite checks the actual skyline axis,
peak and window title, plus the final date of a rolling seven-day matrix.
The four relevant suites passed all 36 tests under UTC, Asia/Singapore and
America/Los_Angeles. Browser inspection of the synthetic cross-day story checked
1200px and 390px widths; long date labels required width-aware tick thinning.
Root `pnpm check` passed typecheck and lint, then failed the unchanged boot-shell
storage-unavailable test (components: 4596 passed, one failed); its isolated run
also failed. Electron's separately run suite passed all 199 tests. Formatting,
the final components typecheck/lint, i18n, import/platform/public-boundary guards
and docs check passed; docs reported existing warnings and no protected topics.
No real account data, permissions
or hosted implementation was changed. Production responses, service boundary
inclusivity, invoice accuracy and native mobile visual acceptance remain unverified.
