# Usage day detail cache

Status: draft
Translation: current

[中文](usage-detail-cache.zh.md)

Opening a previously viewed date in Usage should immediately show its last loaded
breakdown. Switching dates, closing the detail panel, or leaving and reopening
settings must not discard that snapshot while it remains in the bounded cache.
Persist it locally so recreating the application store or reloading the page can
reuse it under the same login session. An unvisited or evicted date shows loading
until its query resolves; a valid zero-usage response is cacheable.

Each successful fetch is fresh for one full hour from its completion time,
independent of clock-hour boundaries. Within that hour, opening the same date
uses the snapshot without starting a detail query. A completed fetch releases
its subscription. Expiry makes the entry eligible for refresh; it does not delete
the data. Only the selected expired date refreshes, including when it remains
open through expiry. Show its old snapshot until the replacement arrives, so an
hourly refresh never creates an empty loading panel. This permits up to one hour
of client-side staleness in addition to query/reporting delays; the view is not
a live usage monitor.

Snapshots belong to one authenticated session, workspace, and date. A different
workspace or session must never display them. Temporary auth recovery may retain
the same session's data. Temporarily missing session identity hides snapshots
without destroying them; confirmed sign-out or a known session change invalidates
them when observed. An absent workspace or usage capability
exposes no detail and starts no detail query. Other query errors keep the existing
error path instead of being silently replaced by cached success.

Both desktop and mobile use the shared detail hook. Invalid stored data is ignored;
unavailable local storage falls back to in-memory caching. Explicit cache repair
removes the persisted usage entries. The local-only platform continues to omit
cloud usage analytics.

## Evidence

- [Shared hook and bounded cache](../packages/components/src/components/settings/settings-data-cache.tsx)
- [Validated persistence](../packages/components/src/components/settings/usage-day-cache.ts)
- [Behavioral regression tests](../packages/components/tests/settings-data-cache.test.tsx)
- [Cache decision](../.agents/notes/implemented/bug-fix/2026-09-21-usage-detail-cache.md)
