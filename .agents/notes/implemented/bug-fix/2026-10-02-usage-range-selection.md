# Keep usage selections closed after range changes

Status: implemented
Translation: current

[中文](2026-10-02-usage-range-selection.zh.md)

## Abstract

Usage already cleared its selected date when switching hourly ranges, but an old
resize or scroll callback could select that date again. The current timeline's
readout could then say no usage while the independent day query displayed a full
day's totals. Position synchronization now updates only the current selected day,
without notifying the query container. Controlled callbacks reproduce the defect
and verify the repair; the production bundle and its exact delivery sequence
remain unverified.

## Evidence and decision

At `ffc6f57f55f97dff60328c0c6433e1b0abf269bb`,
`UsageCalendarVisualization` resets selection when `hourlyRange` changes.
`UsageRangePanel` and `UsageHeatmap` both send caret measurements through
`selectDay`, which can open a selection. The retained cell passes the hourly
panel's `root.contains` check during exit. An exiting heatmap also retains its
scroll listener and observer with the old selected-date prop until unmount.
Its live scroll event reproduces the same mutation.

The mounted [owning suite](../../../../packages/components/tests/usage-timeline.test.tsx)
uses real `AnimatePresence`, synthetic data, an explicit resize callback and
injected time. It verifies that reset closes the parent query selection and UI,
then demonstrates that the old callback reopens both on the original source.
The browser's RangeSwitching story repeats 7d → 24h with a captured observer
callback delivered after the collapse begins, while the old cell remains in its
root. The original path displays Jul 13 “No usage” beside the independently
loaded Jul 13 breakdown; the repaired path remains closed. This is a constructed
browser delivery, not proof that a disconnected native observer necessarily
delivers after cleanup.

Both panels now have separate selection and position callbacks. The parent
checks the existing `notifiedDayRef` before updating the selected and collapsing
caret positions. This ref changes synchronously when selection closes, so a
measurement cannot restore a queued reset or replace another date. Matching
measurements do not notify the query owner. The existing reset, collapse
transition and observer cleanup remain responsible for their original jobs.

No cache invalidation is needed: the [day-cache decision](2026-09-21-usage-detail-cache.md)
still applies. Removing animations or adding observer-specific cancellation
would change more behavior while leaving selection authority mixed with layout.
The [timeline Spec](../../../../specs/usage-timeline.md) owns the range behavior;
the [UTC decision](2026-10-01-usage-timeline-time-basis.md) remains applicable.

## Ablation and verification

| Removed protection                             | Result in the 11-test timeline suite                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| Hourly panel uses selection for resize again   | Four range-transition regressions fail.                                    |
| Heatmap uses selection for resize/scroll again | Two transitions and replacement of a newer date fail.                      |
| Parent date guard removed                      | Seven regressions fail, including UI reopening without query notification. |
| Parent checks only for a non-null selection    | The old date replaces the new date in the rendered panel.                  |
| All final protections present                  | All 11 pass.                                                               |

The suite also checks 24h ↔ 7d, hourly ↔ calendar views, retained 30d ↔ All
selection, reopening by click, close followed by an old callback, transition
completion, and observable caret movement. The four owning usage/cache suites
pass 45 tests. The controlled observer intentionally permits delivery of a
captured callback after disconnect; live native scheduling is not inferred from
that fixture. Screenshots use synthetic Storybook data and are not committed.
The browser also preserves the selected date through 30d ↔ All and closes it
on returning to 24h, with no page errors. Root `pnpm check`, `pnpm format`,
`pnpm build` (local desktop) and docs check pass on Node 26.10.0 / pnpm 10.20.0.
Tests use `NODE_OPTIONS=--no-experimental-webstorage NODE_ENV=test` so jsdom
owns browser storage. Docs report existing warnings and no protected topics;
the build retains its existing large-chunk warnings. Production/native mobile
acceptance and hosted usage accounting were not run.
