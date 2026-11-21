# iPhone Home Screen widgets

Status: implemented locally; simulator build and behavioral checks passed;
distribution and authenticated real-device verification pending.

The small Home Screen widget features one relevant conversation. The medium
widget shows up to three with title, agent, status and recent activity. This uses
the existing WidgetKit extension and App Group; no new Apple identifier,
capability or cloud endpoint is introduced. Taps use the default containing-app
launch, preserving the existing OAuth and website routing policy.

## Information and appearance

The initial count-only overview discarded the useful information in the existing
[Live Activity card](../ios/App/LodyLiveActivityWidget/LodyLiveActivityWidget.swift).
User feedback changed the local implementation to conversation progress. The
existing shared Live Activity selector retains owner/archive/unread semantics and
orders waiting conversations ahead of running conversations and new replies.
Durable `awaitingUserSince` keeps unanswered requests visible after machine
presence expires. Metadata does not distinguish approval from a question, so the
widget says **Waiting for you**; unread means **New reply**, without claiming that
the task completed.

The widget shares the native activity mark, agent logos and blue/orange/green
palette through
[LodyWidgetAppearance.swift](../ios/App/LodyLiveActivityWidget/LodyWidgetAppearance.swift).
The existing session-info and usage-share cards were rendered in Storybook as
references. A subtle blue/teal ground follows the
[usage share card](../../../packages/components/src/components/settings/usage-share-card.tsx).
Signed-out, ready-but-quiet and stale snapshots have distinct readable states.
iOS tinted rendering retains system foreground/background authority. WidgetKit's
root supplies family/rendering mode to the pure content view; visual fixtures
render production content without writing the cache.

## Ownership and local data

- `src/home-widget.ts` subscribes to existing Jotai state, requiring an
  authenticated user, a route-selected workspace and matching ready runtime/meta
  ownership, including `runtime.accountId === user.id`. Shared local auth-clear
  signals close publication for the page lifetime. It reads fresh session presence and existing agent configuration
  names; it opens no session documents and performs no network requests.
- `src/home-widget-core.ts` explicitly projects at most three selected items:
  session ID, title (96 characters), status, agent mark/name and activity time.
  Permission-command/request-ID, message, prompt and credential fields are omitted;
  permitted display text is not inspected for embedded sensitive strings.
  It coalesces scans in a 250ms window anchored to the first input, serializes
  native writes and retains only the newest queued snapshot. Scope loss bypasses
  coalescing. Failed writes remain retryable; unchanged data renews at most every
  five minutes or on foreground resume.
- `LodyHomeWidgetPlugin.swift` decodes typed metadata, and
  `LodyHomeWidgetStore.swift` validates and saves version 2 in
  `group.ai.lody.mobile.onesignal`. Malformed, duplicate, unknown-version and
  future-dated snapshots, excessive item counts and invalid bounded fields are
  rejected. Saving/clearing removes the earlier
  local count-only snapshot while preserving other native preferences.
- `LodyHomeScreenWidget.swift` reads a local timeline and schedules an entry that
  hides session details at 15-minute expiry. iOS controls its presentation; this is a cached
  overview. It does not promise continuous monitoring while the app is suspended.
  No Home Screen permission response actions or new deep-link routing are added.
- App and extension privacy manifests declare UserDefaults reason `1C8F.1` for
  same-App-Group storage, following
  [Apple's API reason documentation](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitypereasons).

These titles are device-local display metadata, matching the existing activity
card. The current [E2EE contract](../../../specs/e2ee/README.md) does not add an
application-level encryption requirement for local content caches. This widget
adds no remote publication or key storage.

## Token usage widget

`src/token-usage-widget.tsx` adds an iOS-only leaf to the existing authenticated
route in the private mobile composition. It uses `usageAnalytics`, the existing
protected `usage:getWorkspaceUsageTimeline` descriptor and shared auth/query
recovery. It creates no Convex client, backend endpoint, Streams subscription or
session-history reader. Only the foreground leaf owns the hourly `day` query;
its lease is shared with the Usage page when arguments match. An optional query
error boundary uses `fallbackRender` to remain invisible on reporting failures;
the shared boundary treats a null `fallback` as absent.

The returned `startMs`, `endMs` and ordered hourly buckets are authoritative.
The current private backend aligns this response to the UTC calendar day and
includes zero future hours; the public draft timeline note describes a rolling
window. The widget therefore derives **Today · UTC** only from a matching UTC
midnight start, otherwise presents the actual window bounds. It does not alter
that draft or claim a deployed aggregation change. Future hours must have zero
usage and remain visibly dim. The projection strips cost and member records,
keeps at most 25 buckets and two top model totals, and preserves a genuine zero.
Input/output/cache-read details are optional; absent values remain absent.
`formatCompactNumber` formats labels in the product language before publication.

`LodyTokenUsageWidgetStore.swift` owns an independent version-1 local cache.
Native validation bounds numbers, text, models and dates. Expiry is tied to the
server's `endMs`, so a resume or locale update cannot renew an old reporting
window. A one-minute future-clock allowance accommodates source/device skew;
future non-zero buckets are rejected. `LodyTokenUsageWidget.swift` shares the
conversation widget's native mark/surface and draws a compact hourly skyline.
Both sizes show the Token total; medium shows model totals or a provided token
split. Only metadata enters the App Group, and WidgetKit performs no network I/O.

Publication is fenced by user, workspace, auth session and exact runtime object.
The entry owns the serialized publisher, coalescing timer and Capacitor listener;
the route owns the query and its error boundary. Background suspension releases
the query without clearing a still-valid same-scope snapshot. Scope loss,
local logout intent and route removal clear; late old-source publication is fenced.
Disposal restores the original route and waits for listener removal and any
non-abortable native write. Query recovery keeps the existing shared budget;
exhaustion clears the optional widget data until a new route/session lifetime.
Native write failures remain retryable on new input/resume.

The native full-data reset from current main clears all three widget stores and the
legacy conversation key after the outgoing renderer and Capacitor writes drain.
Interrupted-reset boot recovery clears them before app import as well. It requests
all three WidgetKit timelines to reload and preserves unrelated App Group preferences.
The Foundation store suite verifies the combined widget-key cleanup.

Mobile now declares the already-used `@lody/platform` and `react-i18next`
dependencies directly. The lockfile adds only those importer edges, preserving
all resolved versions and the pinned public submodule. The Effect feature/fix
assessment retains this small React/Capacitor boundary: mobile still has no
resolved direct Effect dependency, and the shared query/auth orchestration is not
a native migration unit. No migration ledger or completion claim changes.

## Subscription allowance widget (2026-10-15)

`src/provider-quota-widget.ts` adds a separate **Agent limits** widget; Token usage
keeps its existing meaning. It reads provider-scoped `machine.raceLimits` through
the shared normalization helpers, gated by the existing subscription-quota
capability. Only computers owned by the current user are eligible. Profiles and
named windows remain separate. Selection prefers online computers and includes
up to three distinct provider brands before additional profiles; each row shows
its provider/profile and computer, up to two reported windows and an
additional-window count.

The foreground adapter invokes `WorkspaceRuntime.requestProviderRateLimitsRefresh`
for up to three selected query-capable online provider configurations. Activation
and reconnection trigger refresh; unchanged metadata updates do not. This
reuses the [existing runtime/daemon refresh contract](../../../.agents/notes/implemented/architecture/2026-10-13-provider-quota-refresh.md),
including request coalescing and read-only ACP cleanup. It creates no session,
vendor HTTP client, credential copy or widget-extension network request. Older
or unavailable computers retain cached data. Empty ambiguous responses are not
treated as zero allowance. Configurations with API-key overrides are gated by
the existing shared eligibility helper.

`LodyProviderQuotaWidget.swift` shows remaining percentages, provider-supplied
window labels and reset times in small and medium sizes. The small view uses
high-contrast remaining-allowance rings: two reported windows get two rings;
one reported window, including a 7d-only account, gets one larger centred ring.
In every state, the small header matches the conversation widget's 19-point Lody
mark, 14-point bold rounded name and trailing workspace label. Provider identity
sits below the header in the content area. A single ring is 62 points across and
dual rings remain 58 points, leaving room for reset labels and the source-computer
footer within the small family. Both layouts use the same 16-point bold rounded
percentage and 8-point period label, keeping more space inside the single ring.
Long workspace/source names truncate independently
of the Lody name. The footer does not repeat the brand.
Medium uses one provider row with fixed-width allowance bars and percentages.
Common 5h/7d windows align vertically; missing periods leave a blank alignment
space without a track or zero. When every provider reports only 7d, one wider
column uses the quota area. Equal-duration named windows remain separate, in
source order, rather than being assigned to a false period column. The duration
prefix comes from the existing producer's `duration · label` display contract.
Columns have a 12-point gap and an additional 8-point horizontal inset inside
the system widget margins. The gallery includes a 7d-only synthetic provider.

Medium moves a common computer label into the footer only when both the machine
prefix in the provider IDs and the display names match. Different computers
retain per-row names. Allowances at or below 20% use orange; the lowest remaining
window's reset information sits under its provider's name, with elapsed reset
windows taking priority and requesting refresh. Routine per-row reset timestamps
are omitted to leave room for comparing bars. The footer keeps only the source
and snapshot label. No open/refresh action caption or arrow is shown; the whole
widget remains tappable. Small retains its ring presentation.
Actual zero draws an empty track; a passed reset time draws no allowance arc/bar
and shows a refresh request rather than assuming replenishment. These are native
presentation changes; refresh, auth, cache and disposal ownership stay the same.
The 15-minute expiry measures the native cache copy, not vendor freshness: current persisted
rows have no authoritative fetch timestamp. The footer explicitly labels an
allowance snapshot. WidgetKit controls presentation timing.

The new `LodyProviderQuotaWidget.v1` display cache has a 32 KiB serialized limit
on bridge decoding, stored-data decoding and saving, plus UTF-8 field limits.
The bridge size check happens after JSON serialization; it is not a limit on the
initial bridge allocation. Existing conversation/Token formats are unchanged.
All remain unencrypted App Group display caches. Logout/scope loss serializes a
clear after pending writes; full reset removes this exact key as well. Behavioral
tests cover actual quota normalization and runtime refresh, foreground refresh,
API-key exclusion, pending-write logout/disposal, native UTF-8/byte bounds,
reset/expiry boundaries and preservation of unrelated preferences.

## Lifecycle and package boundary

All changes belong to private mobile files; `lody-oss` stays pinned. The mobile
package has no directly resolved Effect dependency. Feature/fix assessment keeps
the small Capacitor/Jotai adapter, with no new runtime or migration completion
claim. The entry owns subscriptions, timers and the Capacitor listener. The
shared auth-clear signal immediately closes all three publishers before sign-out's
network request finishes; initialization also checks the client's existing
logout-intent generation. The latch survives root auth restoration and resume
within that page. Native sign-in replaces the page and creates a new owner.

Scope loss publishes a serialized clear after any non-abortable native write.
Disposal unsubscribes inputs, finishes that clear before stopping the publisher,
and waits for listener removal. It must not discard the queued clear and leave
an old write as the final cache state. Bridge failures have bounded automatic
retries, with fresh ownership checks; new input/resume can rearm recovery.
The [cache recovery decision](2026-10-31-widget-cache-recovery.md) describes metadata
loading and write acknowledgement handling.

## Risk assessment (2026-10-14)

The private repository forces `risk:high` for persisted formats, auth/tenant
boundaries and deletion paths. The incremental consequences differ:

| Area                        | Consequence if wrong                                                    | Verified controls                                                                                                                                                                                                                                                             | Remaining exposure                                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persisted format            | Missing or stale widget information; local metadata disclosure          | Independent versioned display-cache keys, typed projection, validation and recoverable overwrite/clear. No session document, authoritative usage record or credential schema is migrated.                                                                                     | Defaults JSON has no application-level encryption; expiry does not delete it. Conversation/Token decoding has no total-byte limit; quota decoding is capped at 32 KiB.        |
| Account/workspace isolation | Previous identity's workspace name, task title or usage remains visible | Runtime account and ready route/meta ownership, page-lifetime logout-intent fence for all three publishers, session-owner filtering, Token session/runtime fences, and serialized clears retained through disposal. Protected-query recovery remains the authorization owner. | Native readers do not independently check current auth. Cross-process persistence and WidgetKit's presentation timing still need signed-device verification.                  |
| Clearing/reset              | Widget metadata survives, or unrelated storage is accidentally removed  | Only four named widget keys are removed, after the outgoing renderer/native queue drains; interrupted reset repeats this before app import. Actual UserDefaults tests preserve unrelated sentinels.                                                                           | In-memory removal is not proof of cross-process durable deletion or immediate screen erasure. Existing full reset retains its documented credential/server-revocation limits. |

The added cleanup is restricted to `LodyHomeWidgetSummary.v2`, its legacy `.v1`,
`LodyTokenUsageWidget.v1`, and `LodyProviderQuotaWidget.v1` in the existing App Group. It does not clear that
whole domain. Other App Group preferences, including existing Live Activity
configuration, remain owned by their existing lifecycles. The widget addition
does not broaden the existing full reset's deletion of WebKit-local data or
introduce server-side account/document deletion.

Display metadata can still be sensitive. Titles, workspace names, model labels
and usage totals are stored as defaults JSON, accessible to the existing
App Group members, including the OneSignal extension. Typed re-encoding does not
copy credential, prompt, transcript or permission-command fields into the widget
keys. It does not remove sensitive strings embedded in permitted display text,
and this statement does not describe every key in the shared group.
[Apple documents](https://developer.apple.com/documentation/foundation/userdefaults)
unencrypted defaults storage, asynchronous disk persistence and inclusion of
persistent defaults databases in device backups. The feature adds no app-owned
remote publication, but it does not create a backup-exclusion or secure-erasure
guarantee.

Freshness is evaluated against `entry.date`; entries at or after the 15-minute
expiry omit conversation items or usage values, while redrawing an older entry
can retain them. A temporary synthetic probe against the actual stores confirmed
that expired snapshot data remains retrievable from UserDefaults in the same
process; stale views also retain the workspace name.
Clearing requests timeline reloads, and providers schedule stale
entries, but [Apple's timeline contract](https://developer.apple.com/documentation/widgetkit/timeline)
permits later presentation. Neither expiry nor logout promises instantaneous
erasure of a system-rendered widget. Keep this limit explicit when assessing
privacy; cache validation alone cannot establish a screen-erasure deadline.

For the existing conversation/Token caches, native counts and selected text/value
fields are bounded, not the entire serialized payload. A synthetic direct-store probe saved and reloaded a
one-megabyte workspace name; a 200,001-byte combining-character title passed
native field validation without being persisted in the probe. Ordinary producers bound
workspace slugs and slice displayed text before publication, so this did not
demonstrate a shipped P0/P1. Corrupt/direct bridge inputs could still exhaust the
extension's decode budget; a future payload limit must be checked before decode
and tested on both load and save.

The earlier risk assessment changed documentation only. Subsequent deterministic
probes reproduced two actual omissions: ready metadata could pair a new user with
an old runtime, and foreground resume could republish the old title while
sign-out's network request remained pending. An installed-auth-module probe also
showed an already-pending `get-session` response restoring the old raw session
after the native sign-out hook had cleared it.

The code now requires the runtime account to match the current user and latches
`subscribeLocalAuthStateCleared` for the page lifetime. All three publishers share that
gate, so late auth restoration, stale query results and foreground resume cannot
reopen them. Initialization checks `getAuthSessionIntentGeneration` to cover
logout before the widget adapter mounts. Disposal retains the final clear after
pending native writes. This fences widget publication; it does not change the
upstream Better Auth response handling. Normal native login creates a fresh page.

Seven permanent regressions extend the owning suite using actual shared auth
signals, Jotai runtime/route atoms, React Token host and production publishers,
with controlled query results, clock and native writes. All seven fail against the
pre-fix source and pass with the fix. They cover missing/mismatched runtime owner,
delayed logout before root auth cleanup, account replacement with an old ready
runtime, final clears after pending writes, disposal during logout, Token
disposal after confirmed auth loss before root scope cleanup, and
initialization after an earlier logout with a fresh-page publication counterpart.
The existing core and Foundation store suites also verify projection, final state
after overlapping publication/clear, combined-key cleanup and recovery ordering.
Temporary probes using the actual React/Jotai token host, protected query adapter
and error boundary also exercised confirmed logout, detached callbacks,
runtime/workspace replacement, recoverable auth loss and bounded server retries, silent permission
failure, background lease release and disposal while a write is pending.
They do not verify app/extension cross-process persistence, native Preferences
failure, a killed process or system snapshot presentation.

Before claiming those guarantees, exercise a signed device with synthetic
account/workspace A and B: switch during a pending publication, log out offline,
include a delayed old session response, and confirm both native keys and
displayed content; then reset with unrelated
sentinels, interrupt after queue drain or during cleanup, relaunch offline, and
inspect the extension's reads. Also check expiry/background resume, clock changes
and locked-device presentation. Until then, retain `Confidence: medium` and the
PR's explicit verification gaps.

## Verification

- Shipping verification integrates current main without a feature gitlink change.
  The full root build completes workspace/mobile and Web outputs, then stops at
  cloud Electron packaging because this checkout lacks `VITE_ELECTRON_UPDATE_URL`.
  The configured mobile staging and complete iOS simulator builds succeed.
- The first full check run alongside packaging failed two existing CLI operator
  recovery cases at the macOS process-probe boundary. The unchanged Inbox suite
  passes all 55 cases in isolation; the full check passes when rerun without
  concurrent packaging.
- Token-widget implementation passes `pnpm check:affected` including its full
  fallback check after the two importer additions. Public boundary checks pass;
  mobile has 43 JavaScript tests plus both native store suites after integrating
  the latest main's native reset tests and seven auth/publication regressions. The configured
  staging web build, mobile TypeScript and complete simulator build pass.
- Token visual fixtures cover small/medium, both languages, genuine zero, missing
  split, model totals, stale data and large values/long names. The English split
  label uses two lines to retain the complete Cache read caption.
- The installed WidgetKit gallery exposes both Token sizes with synthetic sample
  data. Adding the medium widget beside conversation progress succeeds; its
  signed-out state opens the app's login screen on tap. The temporary visual host
  was removed, leaving the simulator on the Home Screen with both widgets.
- Conversation-widget checks previously passed with 18 JavaScript tests. Token
  tests extend that suite with UTC-day/future-hour and rolling-window projection,
  zero/optional split, bounded model ranking and account/runtime/session fencing.
  Native store tests also verify independent-key clearing and server-based expiry.
- The configured staging Vite build and complete simulator `App` build pass;
  the installed app starts at its login screen. Both small and medium Home
  Screen widgets render the signed-out state.
- Mobile behavioral tests cover ready scope, coalescing, overlapping writes,
  logout/workspace changes, failure/retry, heartbeat/resume and disposal. The new
  conversation projection check protects status semantics and bounded metadata,
  including exclusion of synthetic permission commands and credentials.
- Native tests exercise the actual isolated UserDefaults store: conversation
  round-trip, ready empty state, 15-minute expiry, legacy removal, malformed and
  duplicate items, unknown version/status, and preserving unrelated preferences.
- Mobile TypeScript passes with `tsc -p tsconfig.app.json --noEmit --lib
ES2024,DOM,DOM.Iterable --experimentalDecorators`. These flags cover existing shared
  source requirements omitted by the unchanged mobile tsconfig.
- CocoaPods 1.17.0 and arm64 iOS 26.5 (23F77) are installed. The iPhone 17 Pro
  simulator `Lody Widget Test` runs the app. The complete `App` scheme builds with
  ad hoc simulator signing, including both extensions and the native bridge;
  `cap sync ios --deployment` retained Podfile.lock.
- The initial unconfigured web build failed in Better Auth because missing client
  URL settings fell back to `capacitor://localhost`. Existing staging client
  configuration resolves startup without changing auth source. See
  [simulator build checks](../BUILDING.md#ios-simulator-widget-checks).
- Visual checks use a separate temporary simulator host rendering the production
  SwiftUI view with synthetic conversation data. It is excluded from the app and
  does not read or write the App Group. Checks cover both sizes, waiting/running/
  unread, empty/quiet/stale states, long titles/names and English/Chinese copy.
- No authenticated account was used. Real-session refresh, account/workspace
  transitions, background resume, expiry and disabling Live Activities still
  require device checks. App Store archive/distribution signing is unverified.
- Public documentation checks retain the existing links into uninitialized
  Kimi/Pi submodules. No protected public documentation was changed.
