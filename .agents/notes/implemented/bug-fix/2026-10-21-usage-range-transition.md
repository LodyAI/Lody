# Keep usage range exits inside their frame

Status: implemented
Translation: current

[中文](2026-10-21-usage-range-transition.zh.md)

## Abstract

Switching Usage from 24 hours to All briefly painted the outgoing hourly chart
above its card, while the incoming calendar started 371 separate cell animations.
The view frame now remains positioned across range changes, keeping outgoing
charts in the coordinate system used for their exit measurements. The calendar
uses the whole-view opacity fade instead of individual cell reveals, and the
handoff no longer blurs the entire chart. Synthetic browser checks establish the
geometry and animation-count improvement; production query latency is unmeasured.

## Evidence and decision

The hourly-only ring layout supplied `position: relative`. Removing that layout
for All also removed the containing block while `AnimatePresence` retained its
children as absolutely positioned exit views. Their old parent-relative offsets
then resolved against the page. In the existing statistics Storybook fixture at
1180px, the hourly view moved from approximately (351, 303) to (192, 3) during exit.
The original calendar also started one reveal animation per day: 371 in total.

`UsageCalendarVisualization` now owns an unconditional positioned `viewFrame`.
The ring grid remains conditional, while both outgoing views keep that frame as
their containing block. Opacity alone cross-fades the chart families; removing
the full-view blur and per-cell scale reveals avoids overlapping work on the
incoming calendar. Cell colours, focus, pointer interactions and the existing
reduced-motion behavior remain supported.

Changing the animation's duration alone would retain the misplaced coordinates.
Clipping at the page would hide content without repairing its ownership. The
fixed frame corrects the geometry at its owner without changing the
[UTC timeline contract](../../../../specs/usage-timeline.md), the
[selection lifetime](2026-10-02-usage-range-selection.md), or
[day-detail cache](2026-09-21-usage-detail-cache.md).

## Verification and limits

- The browser suite in `tests/e2e/usage-timeline.spec.ts` observes the actual exit
  commit with `MutationObserver`, rather than sleeping for an assumed duration.
  It checks both switch directions at 1180px and 390px, preserves coordinates
  relative to the frame when a narrow header wraps, verifies that the calendar
  starts no per-day animations, and exercises reduced motion. All four tests pass.
- The initial regressions failed on the original geometry and reported 371 cell
  animations. The repaired calendar reports zero per-day animations.
- The existing timeline, calendar-model, share-statistics and day-cache suites
  pass all 45 tests, including selected-day behavior and UTC bucket formatting.
- Screenshots use the existing synthetic statistics story. No account data or
  screenshot assets are added to the repository.
- Oxlint passes for the changed component and browser suite. Package type checking
  stops on unresolved `jsqr` and `@lody/cloud-api` dependencies elsewhere in the
  current checkout. Root `pnpm check` also stops at the platform package's unresolved
  `@lody/cloud-api` dependency during type checking, before reaching the full suite.

These checks do not establish a hardware-independent latency improvement or
validate hosted query performance. The change is confined to shared presentation.
