# Lody Android

Lody’s native Kotlin/Jetpack Compose client. It supports account authorization,
workspace and project browsing, conversations, task creation, attachments, and
native permission controls. The browser protocol runtime is derived from
[Innei/lody-ios](https://github.com/Innei/lody-ios); see the
[mobile credits](../README.md#credits-and-origins) and
[runtime provenance](runtime/vendor/PROVENANCE.json).

## Run

Use Android Studio Rabbit 1 / AGP 9.4.1, Gradle 9.6.0 and JDK 17+ (validated with the IDE's embedded JDK 21). The Kotlin and Compose compiler versions are pinned together in `gradle/libs.versions.toml`. Compile SDK 37, target SDK 36, minimum SDK 26. Application ID: `ai.lody.android`.

The local installed IDE was 2025.3 at bootstrap; upgrade it before IDE sync with this AGP. Local SDK paths stay in ignored `local.properties`.

Install Node.js 22+ and npm, then:

```sh
cd runtime
npm ci
npm test
cd ..
./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintDebug
./gradlew :app:installDebug
adb shell am start -n ai.lody.android/app.lody.android.diagnostics.RuntimeProbeActivity
```

Gradle generates runtime assets from the vendored snapshot, pinned npm dependencies and Android adapter before packaging. Dependency licenses are bundled alongside the HTML. No dependency on an iOS checkout, login or connected machine is required.

The debug launcher automatically runs compatibility checks and provides Run, Restart, Watchdog recovery, Stop, Details and Switch workspace buttons. Background the app and return to check lifecycle retention. Debug builds can be inspected via `chrome://inspect`; release builds exclude the diagnostic Activity, diagnostic HTML and fault injection.

## Push notifications

The native app supports OneSignal (default) and direct FCM. Only the backend
`pushSubscriptions:configuration` response with `selfHostedEnabled: true` selects
FCM; confirmed `false` selects OneSignal. A failed query or malformed response
reports `unavailable` and preserves the last provider selection; it never silently
falls back. Build properties never override that choice. The OneSignal external
identity is the original verified user ID, unchanged.

OneSignal uses public app ID `e383bf31-7c8e-4641-b3f6-3486e77b9a82`; override with
Gradle property `LODY_ONESIGNAL_APP_ID` for a separately provisioned app. Its
OneSignal dashboard must have Android/FCM credentials configured for this client.
For direct FCM, supply these **public client options** as Gradle properties from
the Firebase Android app registered for `ai.lody.android`:

- `LODY_FIREBASE_APP_ID`
- `LODY_FIREBASE_API_KEY`
- `LODY_FIREBASE_PROJECT_ID`
- `LODY_FIREBASE_SENDER_ID`

The project [gradle.properties](gradle.properties) contains the default public
Firebase client values for `ai.lody.android`, with their source fields in
`google-services.json`. For another Firebase app, override all four values using
the client whose `client_info.android_client_info.package_name` matches the
application ID, then rebuild. The JSON file itself is not loaded automatically.
Overrides can use Gradle `-PLODY_FIREBASE_…=…` arguments or user-level Gradle
properties. Empty values disable direct FCM registration.

They must match the project used by the backend FCM service account. Never put
service-account JSON or server credentials in the app. A build without these
options still supports OneSignal; selecting direct FCM then reports `unavailable`
rather than silently using another provider. The `.m3e` application ID needs its
own matching Firebase registration when used for push verification.

Registration follows verified account restoration, foreground refresh and FCM
token rotation. The native BetterAuth session is exchanged at
`/api/auth/convex/token` for a short-lived Convex JWT; the registration mutation
requires its actual live `sessionId`. A bare CLI API key is not a push credential. Logout/account replacement cancels and joins registration, opts
out/logs out of OneSignal, clears notification navigation and attempts direct
unregistration before native credentials are discarded. Submitted mutations keep
ownership of their response wait despite caller cancellation, bounded to 15 seconds
each (at most one pending mutation plus one cleanup mutation during logout).
Superseded refreshes retain their predecessor's drain, so cancelling an intermediate
waiter cannot orphan a submitted write. Push HTTP requests disable connection retries
and mark bodies one-shot to prevent automatic mutation replay.
Cancellation is not proof that a server mutation was aborted. Once a network timeout
or failed response occurs, the remote commit remains unknown. A late registration
may commit after unregister or after a subsequent account's registration. A successful
local drain or unregister response does not rule that out. The backend also transfers
ownership by token (`sameToken`), so changing only installation IDs would not establish
a fence. This client retains the existing installation identity and provider
best-effort semantics; it adds no durable uncertainty queue, ID/token rotation scheme,
or backend protocol. The backend's live-session checks reject revoked sessions,
but the client does not claim complete remote-write fencing or delivery isolation
while a timed-out request remains ambiguous. `notifications.status` reports
`cleanup_unconfirmed` when cleanup itself fails; a successful cleanup is only its
own acknowledgement, not proof that every earlier request has stopped.
No service credentials persist in the app.

Android 13+ asks notification permission once after verified sign-in. The `lody`
channel handles direct FCM background alerts; foreground delivery uses the native
service. The backend FCM v1 payload contains both `notification: {title, body}` and
`data` (including `route` and raw `recipientUserId`), plus Android
priority `high`, TTL `300s`, channel ID `lody` and an event-derived notification
tag. Firebase renders the notification payload in background and passes its data
through the launch Intent on tap; the service reads `RemoteMessage.notification`
and `RemoteMessage.data` for foreground delivery. It does not expect data-only
payloads or a top-level workspace/session ID. Both providers route `/<workspace slug>/sessions/<session ID>` into Home,
checking the verified account's workspace membership and requiring an explicit,
nonblank recipient ID exactly matching that account. Foreground FCM display and
the OneSignal foreground lifecycle listener reject missing, blank or mismatched
recipients. The OneSignal listener suppresses display while signed out/unverified
or when direct FCM is selected. There is no legacy recipient-less
Android notification fallback. Both providers
select the exact session only once it appears in that workspace's catalog.
No notification URL is opened in a browser.

Native build/tests do not prove delivery. Before release, verify both providers on
a provisioned device: allow/deny permission, foreground/background/killed delivery,
cold and warm notification clicks, token rotation, provider switching and logout.
Already accepted OS notifications cannot be recalled by backend unregistration.
In particular, background FCM `notification + data` messages are rendered by the
Firebase/Android system path, bypassing the foreground service's local account and
provider checks. An already accepted message can therefore appear after logout,
as with an already accepted APNs alert. Tap navigation still validates the restored
account and membership; this client change does not alter the backend payload or
claim to eliminate that OS delivery boundary.

## Appearance

Dark mode uses soft black (`#111113`) for app/page base and grouped surfaces,
including the launch/window background, aligned with iOS. Light mode stays white;
raised surfaces, translucent scrims/shadows and artwork retain their own colors.
There is no separate pure-black mode. The protocol WebView is offscreen and does
not render app pages.

The composer action bar includes a related-conversations capsule when the current
conversation belongs to an opened-by tree. Its native sheet shows ancestors,
descendants and contained Tabs; ordinary Tabs alone do not enable the capsule.
Archived and side-panel entries are excluded, closed Tabs are hidden except for
the current one, and cycles terminate. Navigation requires the exact target and
its containing root in the current catalog; an opener id is never substituted
with a surviving root id.

System operation receipts decode the shared runtime’s `OperationPresentation`
(`OperationEvents`)
and transcript rows (`OperationCards`) for creation progress, create/reply
completion, and completion batches. The shared projection suppresses duplicate
successful creation completion cards while failures, cancellation, missing batch members
and uncertain model delivery remain visible. Rows reuse the conversation list’s agent marks, animated running indicator,
title typography without raised card backgrounds. Receipt targets belonging to
the same conversation share a horizontal row. They show localized states and
bounded reply previews, with catalog-backed titles and disabled navigation for
unavailable targets. A separate View full reply action opens the complete saved
Markdown in a scrollable, selectable bottom sheet, even when its target is gone.
Reply text stays separate from failure detail; upstream truncation is identified
in both the preview and sheet. Lists over five entries can expand.
The relation sheet groups each root and its contained Tabs on one horizontal row.
Overflow scrolls horizontally without a scrollbar; edge fades appear only in
directions with more content. Only opened-by conversations increase hierarchy
depth and receive curved rails, with trunks ending at the last sibling. Each
Tab retains its exact navigation target, agent mark and title. Running, failure,
input-needed and unread states use glyphs with accessible state descriptions,
without duplicate status text or Tab/directory labels. Only the current exact
conversation or Tab receives a subtle selected background and selected semantics. The pinned runtime snapshot emits these operation items through the shared
projection; see [runtime snapshot maintenance](docs/runtime-snapshot.md).
Synthetic Loro history tests cover the bundled projection and JVM protocol tests
cover native consumption. Device rendering and authenticated live delivery have
not been exercised.

Chat links use Web Markdown’s subdued cyan palette. Live work status is text-only,
and an activity summary shimmers only when it is the final visible content of a
working turn. Hidden thoughts/think tools and task/footer bookkeeping do not
displace it; later visible prose does. Finished turn actions align with message
text: Copy, Info and Fork, with 48 dp touch targets. The entire opened-chats family line toggles
its children; the opener row opens the conversation.

User messages collapse to six lines with Show more / Show less and offer Copy through a long-press menu, with Edit available only for
the latest runtime-confirmed editable message. Conversation titles use the 16 sp
body-emphasis style, clipping overflow with a soft trailing-edge fade rather than
an ellipsis (mirrored in RTL, absent when the title fits). Accessibility retains
the full title. The header shows the computer below the title in secondary text with a presence
icon; tapping it opens the owner/visibility panel. There is no bottom computer capsule. The panel
loads owner and private/shared display metadata from `machines:listVisibleMachines`
through the verified native account and reads current runtime presence on opening.
Missing or failed metadata stays explicitly unknown, never implicitly private.
The conversations button appears only with open child Tabs. More contains New
current working directory conversation and access to closed conversations, so
creation and recovery remain available without the conversations button.

Chats grouped by project show a solid project-icon capsule while scrolling when
multiple sections overflow the viewport. It slides in over 180 ms and out over
140 ms, staying opaque over the full-width list throughout. Dismissal removes
pointer and accessibility targets immediately. The capsule is 56 dp wide,
8 dp from the edge, with 12 dp vertical padding. Targets retain a 48 dp pitch,
24 dp logos and 32 dp selection highlights. When sections
exceed the available height, evenly spaced landmarks retain the first and last
sections instead of compressing targets. It lingers for 800 ms after scrolling
or interaction ends (extended by the system accessibility timeout preference).
Tap an icon to jump to that exact section. With landmarks, scrubbing starts from
the tapped section after touch slop, then traverses every section toward either
end of the capsule. Only the visible capsule captures index gestures.
Backgrounding, leaving the list or losing scrollable content dismisses it and
cancels pending jumps. Pinned and unassigned chats have dedicated symbols; project
logos use catalog repository identity and the existing memory/disk image cache,
with a repository glyph while loading or on failure, or a monogram for local
projects. The index highlights the current section and carries status dots.
TalkBack can activate named landmarks or adjust the index range one section at
a time, including omitted sections; its state description names the current section. Other grouping/search views retain
their ordinary list behavior.

### PR links

The PR panel (`PullRequestSheet`) describes any PR through `PullRequestView`, not
only the action bar's. The transcript's `LocalUriHandler` matches links with
`PullRequestLink` (case-insensitive) against `ChatContext.repositories`: the
project's repository, or a multi-repository project's GitHub members from catalog
`Project.repositories`. Matching links open the panel; other links go to the
browser. The bar's own PR opens with the bar's data. Another PR starts from the
session's catalog entry, then fills state, merge state, branch and ±lines from a
GitHub read grant (`PullRequestDetails`); Merge and Delete branch appear only once
that read lands.

### Project files

Conversation More offers Project files for a live conversation in a local project
(`ProjectFiles.browsable`; iOS `openProjectFiles`). `ProjectFilesSheet` is a near
full-screen sheet like the turn's files sheet: folders come from runtime `listDir`
(rooted at the local project, folders first), and a Markdown file (`.md`,
`.markdown`, `.mdx`) is read through `readFile` and rendered block by block with the
transcript's `MarkdownBlock`, with a Source toggle. Relative Markdown links open in
the sheet; web links go to the browser. Other files are listed but not opened in this
first version. Both commands are reads, routed through the existing contract bridge,
and never retried automatically. `ProjectFilesTest` covers the path rules.

## Schedules

The native Schedules tab shows flat rows grouped by Attention, Active, Paused and
Ended, filtered by search. It restores the last successful list from an atomic
display cache scoped to the account and workspace before refreshing. Failed live
reads retain that display. The cache retains at most eight 8 MiB snapshots, prunes
removed workspace access and clears with account data at logout or account change.
Cached rows do not grant write authority.

Pause and resume update the row and its group immediately, suppress further row
commands while pending, and restore the prior row on failure (including unknown
write outcomes). Reads begun before a command cannot overwrite its result. A fresh
read reconciles after completion; optimistic state is never persisted or replayed.

The editor presents stored status and quick actions above Task, When and Run with
cards. Save is in the app bar; Delete is a separate confirmed action. Day selectors
adapt their column count to retain 48 dp touch targets. Run and resume retain the
machine capability gate, writes remain owner-only, and read-only destinations and
scheduled messages keep their existing restrictions. The original rule and unknown
write retry identity handling are unchanged. Open last chat uses Home navigation.

## Settings

Settings Home mirrors iOS flat groups with account/workspace controls, preferences,
Agent settings, Agent Roles, prompt shortcuts, GitHub, Projects and sign-out. There is no Machines, Published shares or
Agent conversation sync destination. Other unfinished settings destinations show an explicit placeholder.

### Project groups

Project groups are desktop's multi-repository projects. Android shows them as iOS does
but does not create or edit them yet.

- Settings › Projects (`ProjectGroupsScreen`) lists the workspace's groups from a fresh
  `projectGroups` read and opens a read-only page with the group's computer, creator and
  members. Local project visibility is not on Android yet.
- Catalog sessions carry the group run's members (`CatalogProjectRun`, cached with the
  catalog). In a group conversation the context capsule summarises repositories, PRs and
  the group-wide diff, and opens a sheet listing every member with its branch, ±diff and
  PR. A member's PR opens the PR panel, whose Merge and Delete branch then act on that PR.
- The bar's own actions stay Create PR / Draft and Commit & Push, sent with web's
  Project group scope (`SessionInfoBarTest`).

Preferences follows iOS: language and notifications open the system pages for this
app, then the queued-message behaviour (`AppPreferences`). Steer applies only when
the conversation's agent advertises `steer`; otherwise a message sent while it works
queues. Android has no alternate app icon.

Agent Roles (`RolesScreen`, runtime `agentRoleSettings`) list your Roles and those
shared by teammates with their emoji, and create, edit and delete your own (emoji
grid, name, description, target agent, sharing, instructions). The last list shows
from process memory while a live read refreshes it; only a live list enables writes.
Saves and deletes show at once and roll back on failure; unknown outcomes are never
replayed. Canonical role settings validate ownership and conflicts.

Prompt shortcuts (`ShortcutsScreen`, runtime `shortcutSettings`) list private and
workspace shortcuts with their `/slug`, read a fresh body before editing, and create or
edit simple ones (name, slug, prompt; visibility only when creating), as iOS: owner
only, and shortcuts with a project / computer / provider scope or structured references
stay view only. A save shows at once and rolls back on failure; an unknown outcome holds
the same payload so the only next step is retrying that save. The runtime's
`shortcutCloud` host calls (`listAccessibleDocuments`, `getStreamToken`, `stageDocument`,
`activateDocument`) reach `PromptShortcutCloud`, which calls `promptShortcuts:*` on Convex
with the verified account and the native workspace; mutations use a one-shot client.
This also lets the composer's `/` shortcuts load their bodies.

GitHub (`GitHubSettingsScreen`) mirrors iOS Settings › GitHub: personal identity with an
"Act as you" switch (turning it on needs a live authorization), Manage GitHub App for owners
and admins (the App's install page in the browser; the page re-reads on return), then the
workspace repositories with owner logos, Material switches and a search field. `GitHubSettingsCloud`
ports iOS `WorkspaceSettingsCloud.github` over Convex with the verified account: writes check the
row first, are never retried, and count only after a read back. The last complete read shows at
once from process memory while a quiet refresh runs; because the list rarely changes its switches
work straight away (each write re-reads the role and repositories), and a write supersedes that
refresh. A flipped switch shows at once; a failed or unknown write rolls it back and locks writes
until a fresh read (`GitHubSettingsTest`).

Agent settings select one machine above its provider list (online and own machines
first); the top bar's "+" adds a provider to it, and the last list shows from process
memory while refreshing. Deletions leave the list at once and return on failure. Native forms support
catalog entries and presets, names/prompts/descriptions, custom commands, write-only
environment changes, endpoints, Codex profiles, runtime paths and capability-derived
title options. Stored credential values are never returned to forms; omitting an
environment key preserves it, explicit removal sends null, and an empty replacement
saves an empty string. Detail revisions fence advanced edits against concurrent changes.

Providers offer edit, probe, refresh and confirmed deletion. Durable setup rows show
progress, authentication needs and failures with retry/removal. Interactive ACP sign-in
supports methods, browser authorization, codes, form inputs, consent, status and cancel.
Final method menus start a new flow; resumable interactions submit to their existing
flow. Consent must be acknowledged before opening the authorization URL, and verifying
remains a nonterminal state.
Runtime controls expose status/install with progress, Pi extension discovery/selection
and active quota refresh. Sorbet connection/endpoint-store management remains unavailable
because native encrypted feature transport is missing; ordinary ACP sign-in uses its
public encrypted input protocol.

Only a fresh snapshot enables owner/online writes. Mutation responses replace the
target machine’s providers/setups while retaining other still-visible machines.
`agentProvidersChanged` queues a target-only refresh behind any pending mutation, so
setup transitions are reconciled without unrelated machine reads. Unknown outcomes
disable editing until a successful refresh and never replay a write.
Catalog `agentUsage` selects eligible, exact provider/config quotas and renders
shared session usage meters and reset-time controls. Absent usage stays hidden.

The native adapter uses canonical `agentProviders`, `agentProviderDetail`,
`agentProviderProbe`, `agentProviderAuth` and `agentProviderOperation` with verified
native identity. The reviewed runtime snapshot is fixed at
`041760cfd7982cf3b7298b37cf0e668b180a216f` with matching provenance and hashes.
Native compilation and synthetic acceptance do not establish cloud integration.

`ANDROID_SERIAL=<disposable-emulator> python3 verification/agent-settings.py` runs
the debug-only synthetic fixture through the production Compose screens. It checks
Settings without Machines, machine selection, creation on an empty machine,
other-machine list retention and readonly/offline gates, then exercises synthetic
sign-in and runtime controls. Screenshots are saved under ignored
`verification/evidence/agent-settings`. No account login or real provider write occurs.
[Agent acceptance results](verification/agent-settings-results.json) distinguish
native synthetic UI, build checks and real WebView instrumentation. Loro uses its
public asynchronous web initializer with bundled bytes: the base64 initializer's
synchronous compilation exceeded Android WebView's main-thread 4 KiB limit. This
is a startup implementation fix, verified on the same API 34 / WebView 113 engine;
it does not require an engine upgrade or a modified vendor snapshot. Authenticated
cloud integration remains unverified.

## Verification

With an emulator or device connected:

```sh
./gradlew :app:connectedDebugAndroidTest
```

Tests use real Android WebViews, not mocked JS. See Gradle HTML reports in `app/build/reports/` and the checked-in verification summary for actual device coverage. A passing local probe does not claim authenticated cloud synchronization works.

## Architecture and next integration steps

Decisions are in [AGENTS.md](AGENTS.md); details, lifecycle guarantees and current limitations are in [runtime architecture](docs/runtime-architecture.md).

The host interface is replaceable and uses typed coroutine commands, status, events and errors. The Application owns account/workspace leases; Activity recreation and navigation preserve the runtime. Native authentication uses OkHttp and Keystore-backed encrypted credentials. CatalogRepository owns the display projection; a replaceable AtomicFile store caches synchronized catalogs. Dependencies are constructed explicitly in the Application. Native product navigation, message history and sending use that runtime boundary. The shared Zod dependency is pinned to patched 4.6.7 with compatibility tests and a clean production dependency audit.

Phase-1 reports are in [verification/results.json](verification/results.json). On the installed debug app, `python3 verification/phase1-device.py` verifies a real Home/background transition, navigation, workspace switching and force-stop/relaunch; set `ADB` and `ANDROID_SERIAL` for another caller-owned device. It saves screenshots and a short video under `verification/evidence/phase-1`.

## Phase 2 cloud probe

Open **Open cloud connection** in the debug launcher, or launch `.diagnostics.CloudProbeActivity`. Open the native Home sign-in, authenticate with email/password, Google, or a provider-only browser OAuth flow, then choose a workspace. See [native authentication and provider configuration](docs/native-auth.md). The screen distinguishes connecting, syncing, live, paused and unavailable states and offers disconnect/sign-out. No desktop token is required or accepted.

See [phase-2 architecture](docs/phase-2-architecture.md) for account, credential, network and grant ownership. The debug cloud probe is excluded from release; real-cloud acceptance is tracked separately from offline fixtures.

### Catalog cache foundation

The debug cloud probe now restores the saved workspace and catalog projection before online synchronization. Cached account context is explicitly unverified and cannot request grants. A failed cloud connection retains cached display. Network validation while foregrounded retries an unavailable read lease. See [cache architecture](docs/catalog-cache.md) and [scope](docs/phase-3-cache.md). Native conversations build on this cached catalog projection.

Local screenshots, recordings and raw verification reports are excluded from Git. Checked-in verification summaries distinguish deterministic tests from real-cloud acceptance and remaining checks.

## Build-time backend configuration

See [backend configuration](docs/backend-configuration.md) for the shared local env file,
process overrides, mandatory TLS and endpoint-isolated storage.

### Conversation usage

The composer displays context consumption and eligible subscription windows beside
Send/Stop, with a details popover and relative/absolute reset-time buttons.
`SessionSnapshot.usage` consumes an optional session-envelope `usage` projection:
`context: { used, size }`, `isContextCompacting`, `quotaEligible`, `modelId`, `modelLabel`, and
`quota: { id, provider, agentConfigId, name?, windows: [{ label?, usedPercent, duration?, resetsAt? }] }`.
Durations and reset timestamps are seconds (reset timestamps are Unix time).
The shared runtime must resolve the selected model/config and apply capability
and authentication eligibility before setting `quotaEligible: true` and emitting `quota`. Older
runtimes without this projection hide the indicator rather than inventing usage.
Runtime delivery of this new projection is coordinated separately from native UI.
