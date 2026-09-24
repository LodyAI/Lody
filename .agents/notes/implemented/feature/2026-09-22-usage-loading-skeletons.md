# Usage page loading skeletons

Status: implemented
Translation: current

[中文](2026-09-22-usage-loading-skeletons.zh.md)

## Abstract

The Usage settings page visibly jumped when data loaded: the calendar card was
absent until both its query and the lazy three.js chunk resolved, the stacked
area charts rendered a short "No usage data" card while loading (loading and
empty shared the same state), and a separate dashed "Loading usage data" box
appeared and disappeared. Loading is now a first-class visual state: the charts
render a chart-shaped skeleton at the real chart height, and a lightweight
calendar skeleton holds the section's footprint as the Suspense fallback and
while the calendar query is in flight. The bottom loading box is removed, so the
page's geometry is stable from first paint and loaded content replaces the
placeholders in place.

## Decision

- `UsageStackedAreaChart` accepts `loading`/`loadingText`. When `loading` is true
  and no data is prepared, it renders its normal card frame plus a plot-area
  skeleton (layered area silhouette, gridlines, axis ticks) at
  `CHART_HEIGHT_DESKTOP`/`CHART_HEIGHT_MOBILE` and legend placeholders. Once a
  chart has data it stays mounted during background refreshes — the skeleton
  never replaces live data.
- `usage-calendar-geometry.ts` is a new dependency-free leaf holding the 53×7
  grid constants and heatmap sizing shared by the real visualization and the
  skeleton. `usage-calendar-model.ts` re-exports the moved constants so existing
  imports keep working; the lazy-boundary rule (no three.js outside
  `usage-calendar-visualization`'s module graph) is preserved because the
  skeleton imports only the leaf.
- `UsageCalendarSkeleton` mirrors the real card's per-range layouts instead of
  one generic shape. Shared chrome (real i18n header copy, metric-toggle
  placeholder, composition + five-stat footer band) wraps three body variants
  dispatched on `range`: `day` = ring column + 24 skyline bars + hour axis,
  `week` = ring column + 7×24 dot matrix with day gutter + hour axis,
  `month`/`total` = 53×7 year heatmap with month labels, weekday gutter, and
  the Less–More legend row. The variants are separate presentational components
  under one dispatcher, so the body shape matches what the visualization will
  render for the active range.
- `stats-setting-pure.tsx` renders the skeleton whenever a workspace is selected
  and `usageCalendar` is undefined, and uses it as the Suspense fallback.
  `getWorkspaceUsageCalendar` returns a non-nullable calendar (an empty
  workspace still receives a zeroed object), so `undefined` after selection only
  means "query in flight". The same gating applies in
  `mobile-stats-settings.tsx`, which imports the visualization eagerly.
- The transient dashed loading box is removed; `loadingText` keeps an
  `sr-only` announcement via the existing `workspace.usage.loading` string.
- The KPI tiles keep the "—" placeholder but reserve the resolved value row's
  height (`min-h-[4.25rem]` ≈ NumberFlow's 68px at the 2.75rem clamp cap), so
  the band no longer grows when totals arrive.
- Loading, empty, and no-workspace remain distinct states: empty renders only
  when `loading` is false and no buckets exist.

## Alternatives considered

- Keeping the real card mounted with hidden content or forcing zeroed fixture
  data through `prepareChart`: rejected — fake data can leak through formatting
  paths and still reflows when series differ.
- Importing `usage-calendar-model.ts` from the skeleton for the grid constants:
  rejected — it pulls three.js into every consumer, breaking the lazy boundary
  that keeps a second React renderer out of the public landing and SSR paths.

## Verification

- Storybook: `Loading` renders the persistent skeleton; `LoadingTransition`
  (new, `latencyMs` arg) resolves into the loaded view for visual review;
  `Empty` and `NoWorkspace` unchanged in meaning.
- Playwright recordings of the transition before and after the change
  (temporary captures outside the repo) confirm the loading frame now occupies
  the same layout as the loaded page.
- `pnpm run typecheck` shows no errors in the touched files (pre-existing
  cross-package implicit-any noise remains in this partially installed
  worktree); `usage-calendar-model`/`usage-share-stats` tests pass.

## Limits

- The KPI tiles still show a textual "—" rather than skeleton bars; only the
  row height is reserved.
- The calendar skeleton matches the real card's measured height exactly in
  every range (pill rows stand on real line boxes via `leading-[1.45]`, and
  static labels like Less/More render real i18n text), but fine details (dot
  density, bar weights, the month highlight window) are representative rather
  than pixel-exact, and must be kept in sync when the visualization's layout
  constants change.
