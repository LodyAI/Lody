# Retain loaded usage day details

Status: implemented
Translation: current
PR: [#868](https://github.com/LodyAI/Lody/pull/868)

[中文](2026-09-21-usage-detail-cache.zh.md)

## Abstract

Usage day details depended on the selected date's live query, so revisiting a date
could replace loaded numbers with a loading state and reconnect the query.
The shared hook now persists bounded snapshots and skips detail queries for one
hour after each successful fetch. Expired entries remain visible during refresh,
including after settings remounts or page reloads. Login-session and workspace
isolation remain enforced; the trade-off is up to one hour of client-side staleness.

## Decision and ownership

`SettingsDataCacheProvider` keeps overview queries mounted, but its previous
`useSettingsUsageDay` implementation did not retain a date-indexed result. The
recoverable query hook only keeps the last committed query snapshot, which cannot
cover A → B → A navigation or a settings remount.

`usage-day-cache.ts` owns schema-validated persistence under `lody:usageDayDetails`
and an app-store atom. It retains at most 128 snapshots across workspaces for one
login session. The hook reads persistence before its first query decision, then
writes matching responses with their completion timestamp. Each response moves
that entry to the end; overflow drops the oldest stored response. Explicit cache
repair includes the new storage key; unavailable storage leaves memory caching
usable.

`useSettingsUsageDay` skips the detail query while its matching entry is under
one hour old, and releases the subscription after a successful response. A timer
refreshes the selected date at expiry; reopening an expired date also refreshes.
Expiry does not delete the snapshot. This prevents recurrent loading gaps without
keeping every visited query subscribed. Permanent caching would freeze totals and
miss late reports; a live subscription on every reopen would retain the repeated
request behavior. The one-hour interval starts at completion, not the next clock
hour, so a fetch just before an hour boundary still gets a full hour.

An unknown session ID during auth recovery hides data but does not clear it.
Confirmed sign-out or a known session change clears snapshots when observed;
scope checks hide mismatched values immediately. Persistence remains inaccessible
to a different session even if settings were unmounted during the change.

This extends the Usage screen described by the
[usage share report decision](../feature/2026-09-09-usage-share-image.md) without
changing exported cards or usage accounting.

The [draft Spec](../../../../specs/usage-detail-cache.md) owns the intended behavior.
Implementation and tests are linked there. No backend or platform composition
changes are required.

## Verification

Fake-clock tests exercise the full-hour boundary, unchanged refresh responses,
persisted reloads, expired-data display, zero usage, workspace/session isolation,
temporary missing identity, mismatched responses, eviction, malformed storage,
failed storage writes, and the local capability gate. Cache-repair tests verify
the new key is removed while auth and preferences survive.

All 53 tests passed across settings caching, cache repair, calendar model, share
statistics, and recoverable-query suites. Scoped lint has no errors (one existing
cache-repair warning); scoped formatting, platform-boundary, and Code Collab
import checks pass. On Node 26, run with
`NODE_OPTIONS=--no-experimental-webstorage NODE_ENV=test` so jsdom owns storage
instead of Node's experimental globals. Verification reuses installed test
dependencies for this worktree. `pnpm check` and package typechecking remain
blocked by missing worktree dependencies. `pnpm format` stops because the
cloud-api package cannot resolve Oxfmt; the changed source and tests pass Oxfmt
0.65.0 directly. Documentation/public-boundary checks retain existing
uninitialized-submodule links/packages. Live hosted-service and visual acceptance
remain outside this verification.
