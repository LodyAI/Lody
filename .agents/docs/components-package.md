# `@lody/components`: why the shared-UI rules read the way they do

Scope: `packages/components`. The binding rules live in
[that package's AGENTS.md](../../packages/components/AGENTS.md) and its child scopes;
this page keeps the reasoning that would otherwise crowd them out.

Workspace durable synchronization is composed by `providers/workspace-streams-transport.ts`.
Its [content boundary](../../specs/workspace-streams-content.md) keeps ordinary SDK bytes
and persistence intact while exposing protection and snapshot handling to future callers.
The protected seam is not a product E2EE entry point or a persisted-mode resolver.
The owning transport suite also composes merged P07 signature/AEAD and P08 current
ledger replay through the published Repo 0.22.0 interfaces, using a synthetic
native test signer. It checks v0 batches, compressed snapshots, safe error reasons
and durable state/cursor retention. This [P10 preparation](../notes/implemented/testing/2026-10-11-e2ee-sdk-preparation.md)
does not supply historical-author authorization, a production signer, host snapshot
admission or client recovery from an unusable remote snapshot.

## Startup frame and handoff

The [startup intent](../../specs/app-startup-landing.md) keeps destination selection
and workspace readiness separate. Static BootShell and real `WorkspaceCard` share
`lib/workspace-frame.ts`'s document-safe `WORKSPACE_FRAME_CSS`: a 4px shell rim,
14px concentric radius, 0.5px border and shadow, with the real card's values mapped to
UI StyleX tokens. The rim keeps the page distinct without reading as a floating card.
On macOS, frame-aware top rows compensate for that 4px origin so their controls retain
the native traffic lights' y=23 centreline. The shadow is a single 1px-down, 2px-blur
black layer at 3% opacity.
`DocumentStyle` renders mutable React style elements and retires the inline
first-paint sheet in a layout effect after its replacement commits. A hoisted
`style href` ignores later content changes, so it must not own these live styles.
Before paint, the boot script records plain/workspace layout, stored width,
theme and mobile/compact state. A collapsed sidebar still leaves workspace-card
geometry; it does not imply plain layout.

Inside `RootOutlet`'s error boundary, `BootShellBoundary` reads live route, sidebar
and viewport state, plus router `state.isLoading || state.status === 'pending'`
as the provider's `pending` input. Both conditions matter: `isLoading` can become
false before the pending match renders.
`BootShellProvider` keeps one dormant visual frame mounted;
committed `BootShell` gates register path/status in layout effects. The latest
committed owner wins, and cleanup removes only that owner's ID. Suspense can clean
up outgoing layout effects before the destination is ready, so with no owners the
provider retains the last committed presentation while `pending` is true. Once no
owners remain and `pending` is false, it releases the frame and clears that memory;
later ordinary session navigation cannot revive the fullscreen boot overlay. `BootNavigate`
hints destination geometry before navigation completes. Login's `BrowserRedirect`
uses BootShell during asynchronous handoff; Electron completion uses the boot variant.

Presentation proceeds from static shell through React gates, redirect hints and
`PreloadedMainLayout`'s lazy fallback to the actual card. Content readiness keeps
its existing `LoadingPlaceholder`, using the same mark. No workspace UI or provider
mounts merely to draw boot presentation, and unresolved scope still fails closed.
Release after owners are gone and navigation has settled immediately makes the
frame inert and `aria-hidden` and removes live status; its 160ms fade and 320ms
geometry transitions are decorative.
Reduced motion disables animation. No timer or animation event decides readiness.
The outer error boundary unmounts the coordinator on failure, and
`BlockingWaitPlaceholder` recovery replaces its gate with immediately usable controls.

The [handoff decision](../notes/implemented/feature/2026-10-19-boot-shell-layout-handoff.md)
explains the retained DOM and owner-protocol trade-off, partially revising the
[first-paint note](../notes/implemented/feature/2026-09-26-boot-shell-first-paint.md)'s
overlay decision without changing startup guarantees. The
[thin-frame correction](../notes/implemented/bug-fix/2026-10-23-thin-workspace-frame.md)
owns the current geometry and traffic-light alignment.

## Crash surfaces

Recovery and diagnostic contracts, including callers outside `lib/`, are owned by
[the helper rules](../../packages/components/src/lib/AGENTS.md#crash-recovery-and-diagnostics).

A crash the user cannot read or copy is a crash we never hear about, which is why the
`ErrorBoundary` fallback shows the real error text and offers a one-click copy of the
full report on every build rather than only in development.

Crash screens wait for explicit user recovery; `resetKeys` cannot clear an error.
Authenticated cloud queries retry opaque server failures before reaching a boundary,
with a shared, finite budget. Pending retries return loading rather than stale access
rows. Structured application failures and exhausted retries still throw; the runtime
provider has its own page boundary because it sits above the Outlet boundary. See the
[query adapter](../../packages/components/src/hooks/README.md#cloud-query-recovery).

Both cache-recovery levels defer their asynchronous deletes to the next boot because
`deleteDatabase()` blocks while the runtime still holds a connection; synchronous
storage is cleared first so the boot flag is never written over a half-cleared state.
The localStorage sweep is an explicit DELETE list rather than a keep-allowlist so that
the failure mode of forgetting a key is a surviving cache entry, not a wiped user
preference.

The report carries the tail of `lib/session-render-trace.ts` because a React #185
(nested update limit) report names the fiber where the limit tripped, not the loop that
drove it. The trace is diagnostics only, and its surface mount/unmount lines are written
from a layout effect because passive effects may never flush inside a crashing cascade.

`maybeClearLodyCacheOnBoot` is shared by `AppInitializer` and `RuntimeProvider` so a
user wedged before any workspace still gets the wipe, and so the repo IndexedDB is never
opened before the pending clear has run.

`stuck-connection-banner.tsx` is observational because a slow first sync is not a
failure: after 45s of continuous `loading` the banner reports once
(`workspace/boot_wait_stuck`, gate `control_connection_loading`) and offers the recovery
page below, while the connection attempt completes exactly as it would without it. A cache
clear alone was not enough there: it keeps the sign-in credential, which a reinstall
replaces.

No screen may leave a user with reinstalling as the only way out. Every route wait
(`routes/index.tsx`, `$workspaceName.tsx`, `$workspaceName/_auth.tsx`) renders
`blocking-wait-placeholder.tsx` with a `gate` naming what it waits for. It stays a
spinner until the wait fails or lasts 30s, then becomes a recovery page:

1. reload;
2. clear the local cache;
3. copy diagnostics: gate, scope blocker, idle gap before launch, last clear;
4. clear all local data and sign out.

Route failures go through `RouteMessage` with a `gate`. It always offers a retry
(reload when the caller has none, since the mobile app cannot refresh) and the same
recovery page. `gate: null` marks a message that is not a failure, such as a plan limit.

The two scope blockers nothing retries within a page load, `runtime_init_failed` and
`doc_meta_scan_failed`, show the recovery page at once instead of after 30s. The page
says local data may be damaged only for a storage error: a scan failure, or a runtime
that failed with an IndexedDB or `RepoStorageError` name. Nothing clears
automatically: the repo replica can hold edits that never synced, and a failure that
looks terminal can be transient, so every deletion is the person's choice.

A session check that keeps failing (offline, a 5xx, a timeout) is deliberately not
treated as a sign-out, so a wait can be stuck on the server rather than on local
data. `lib/boot-request-failures.ts` keeps the latest failing session, workspace-list,
active-workspace or switch request; while one is failing, the recovery page names it
(network, server with its HTTP status, rate limit, rejected sign-in) and says the
device is not the problem.

Clears take effect at the next boot:

- **Restarting into a clear.** Clearing the cache reloads the one window, as Settings
  always has. Relaunching the desktop stops the embedded CLI and its running agents,
  so it is used only to retry a clear that left databases behind earlier the same
  day, because the storage backend that failed lives on in this process. The relaunch
  goes through the same one-shot request as `lody app reset-cache`. A quit answered
  Stay arms nothing and withdraws the request.
- **Verifying a clear.** The boot clear re-enumerates databases and writes
  `lody:lastLocalClear`. A clear is never re-run on its own: a re-run deletes
  everything again, which after a hard reset would sign the person out a second time.
  Within a day of a clear that left databases behind, the recovery page says so.
- **Hard reset.** It prefers the host: the desktop relaunches into the native wipe, and
  a mobile shell implements `window.__LODY_NATIVE_RESET__`. Only those delete at the
  file level, which is what reinstalling did.

A spent workspace-list retry burst retries again on `online`, on return to the
foreground and every 30s while the page is visible. [Decision](../notes/implemented/bug-fix/2026-10-13-workspace-open-recovery.md).

## Locally accepted messages

Child-tab draft promotion uses the same first-message acceptance unit as other
new conversations. `handleSendDraft` in `sessions/session-detail.tsx` commits the
metadata and first turn together through `startSession`, then promotes the tab.
This order prevents a visible promoted tab without its locally durable message;
a ref flushed after mount would reverse that boundary. The input draft cache
carries preserved composer text across promotion, while `requestSessionDispatch`
accelerates the already durable pointer. Binding draft and close rules remain in
[the product-surface instructions](../../packages/components/src/components/AGENTS.md#entry-points-drafts-and-layout).

Loro ready messages commit to the live local history document. A ready Roost
input instead appears from the workspace's immutable input projection and saves
to account/workspace-scoped IndexedDB without waiting for owner RPC. Normal rows
reuse `UserChatBubble`, including ready media and mention spans, with the ordinary
pending delivery circle and no separate acceptance badge. The circle remains
through local saving and unconfirmed owner work. A positive active owner receipt
publishes the existing delivery overlay; both the local row and authoritative row
use it, so history handoff cannot flash back to sending. A persisted `confirmed`
source state alone is not a receipt. First paint precedes the storage transaction
and does not prove crash durability.

Background persistence is independent of displaying that input, but owner handoff
waits for source save, the session lease and the persisted unknown-outcome marker.
Ready local inputs are individual `SessionChatStreamView.localUserMessages` engine
rows, keyed by their immutable turn IDs. Send anchoring can resolve before owner
history; a matching directory placeholder retains the local body, then hydrated
formal history replaces it once under the same key. Cleanup requires the hydrated
body, not just index membership. Unprepared attachments remain in `trailingContent`.
Local rows never enter authoritative history, outline, export or history selection
leases. Native text copy can still retain their mounted UI without fabricating a
history body. Local ordinary input displays truthful sending activity while its
outcome is unresolved and error-free; actual presence and formal pre-start take
priority. Startup/Stop derivation still requires the existing formal evidence. The
[current send comparison](../notes/proposed/architecture/2026-10-13-backend-independent-send-acceptance.md#current-lororoost-send-comparison-2026-10-15)
records the original integration gap, controlled ordering probes and repair limits.

The metadata circle is separate from the loading spinner beside the bubble.
Ready Roost input uses the same 500 ms loading delay as the ordinary Loro row,
with the same narrow-column visibility threshold. Its delay follows unresolved
owner confirmation, rather than synchronization of the Loro control document.
An input error stops the spinner; retry starts a new delay, and a real delivery
receipt removes it immediately.

Creating a Roost conversation commits routing metadata before admission, without
opening its history store on that path. Background delivery persists the trusted
`humanInputReceipts` control record before accepting owner history; Loro writes
and control queues preserve the same provenance-before-activation ordering.
Receipt lookup stays read-only.

Ordinary Roost sends negotiate `sessionInputDispatch` v1 and use one
`accept_input_and_dispatch` owner request. The native writer queue commits trusted
human provenance and immutable history, checks current status/metadata, and publishes
activation before replying; the host wakes its existing history dispatcher without
awaiting execution. The sender neither rereads history nor sends a second dispatch
RPC. Recovery queries remain read-only and retry the same combined operation for
activation, without recreating removed input. Older owners refuse admission before
draft consumption. Guide application and its no-replay fence remain separate.

New input uses ordinary history-write normalization before storage validation,
including ready file/image records with `text: undefined`. Persisted records still
decode strictly, and same-ID content conflicts still fail. After attachment
preparation hands input to the durable owner, retry targets that owner even while
the memory queue awaits it; preparation-only failures still retry preparation.

The workspace owns restoration, session Web Locks and input reconciliation.
History operations resolve the fixed owner's current local/cloud plane, including
after a late local identity probe; cached stores do not freeze that transport.
Unknown history outcomes query or repeat the same immutable accept operation;
execution delivery follows only its owner receipt. The projection stays until
the authoritative view contains the same ID. Control queues keep the Loro writer
and wait behind earlier input under the same lease. Unprepared attachments remain
in the existing memory queue. Cache recovery preserves saved input; full reset
may delete it. See the [owning decision](../notes/proposed/architecture/2026-10-13-backend-independent-send-acceptance.md).

## File preview versus Code Collab

File routing, cache, and caller contracts live in
[the helper rules](../../packages/components/src/lib/AGENTS.md#file-preview-and-code-collab).
[File identity background](components-file-paths.md) explains path provenance,
cache aliases, and the existing inspection gaps.

Opening a file to look at it is not a collaboration session. File Preview v3 answers with
a plain read — no workspace watch, no All Changes recompute, no Flock publish — which is
why the file index is only a hint there: a path the index has never seen (an
agent-produced temporary file, say) is still worth sending to the machine, and "too large
to preview" is mostly a remote verdict rather than a fact about a file on this machine,
since the local IPC path reads to `FILE_PREVIEW_V3_LOCAL_LIMITS` derived from the 16 MiB
local response cap.

Preview reads a wider path set than `save-text` writes, which stay inside the session
workspace. Without forcing `external: true` results readonly the editor would show a Save
button for a file the machine will refuse, and the user would lose the edit at save time.

## Theming and fields

Reusable visual primitives and semantic design tokens are owned by
[`@lody/ui`](../../packages/ui/README.md). `@lody/components` composes those
primitives into product surfaces and may add layout or interaction constraints,
while the primitive's props remain the owner of its visual variant, size, tone,
and shape.

For appearance-only migrations, keep each product component's visual rules in a
module-level `stylex.create` definition and name styles by their semantic role.
Reuse existing area surfaces and product tokens where they match; retain exact
CSS variables and dimensions when no equivalent token exists. Keep runtime
geometry and styles owned by external rendering engines at their existing dynamic
boundary. Configure shared primitives through their documented props when those
props reproduce the existing appearance. The [progressive StyleX migration note](../notes/implemented/simplification/2026-10-04-complex-surfaces-stylex.md) records the retained legacy overrides and
current application of these rules.

Lody Light's neutral surfaces, text, gray ramp and shadow ink use zero saturation
at their existing lightness; the blue primary and links remain semantic accents. Their
sources are the bundled VS Code theme, `@lody/ui`'s light palette and the Tailwind
fallbacks. `boot-shell.ts` mirrors the sidebar, edge and status colors before the
renderer starts. Keep those sources aligned when changing this palette. The
[neutral gray decision](../notes/implemented/bug-fix/2026-10-17-neutral-light-grays.md)
records the color correction and its verification limits.

The [sidebar tree background](components-sidebar-session-tree.md) explains row
geometry and opener navigation. The
[folded-group status decision](../notes/implemented/feature/2026-09-26-sidebar-folded-group-status.md)
explains why a folded header uses one activity mark instead of counts.

Settings' `CompactRow` keeps its label and helper in separate text nodes. Its
optional `labelId` and `helperId` let a caller associate a control with those
nodes through `aria-labelledby` and `aria-describedby`; visual adjacency alone
does not name a control. The Preferences switches use this association with the
existing translated copy. See the
[decision and browser regression](../notes/implemented/bug-fix/2026-10-01-preferences-switch-names.md).

Machine-list filters compose `Menu.Content width="compact"` and
`Menu.CheckboxItem indicatorSide="end"`. The trigger names this two-option menu,
so the popup contains only the independent filters. The shared checkable row
keeps keyboard and multi-select behavior; its existing start-aligned indicator
remains the default for other menus.

`--input` is the theme's raw `input.background` and doubles as a muted chip/composer
slab, so in a light theme it can sit below the page color and read as a disabled field.
`--input-field` is derived in `lib/vscode-theme/vscode-theme-css.ts` as the lighter of
the field and page colors, which keeps a dark theme's raised fill and lifts a light
theme's field onto the page. Keeping gray exclusively for `disabled:bg-muted` is what
makes disabled state legible at all.

## Emoji picker dataset

`frimousse` fetches its dataset from a public CDN by default, which leaves the picker
spinning forever in an offline desktop or mobile app. The bundled dataset is a URL
contract rather than an import: the library builds `${emojibaseUrl}/${locale}/…` paths at
runtime, so a hashed `?url` asset cannot satisfy it and a host that forgets the Vite
plugin ships an empty picker. Anchoring on `document.baseURI` fails for the same class of
reason — the router uses browser history, so a deep route resolves the dataset path
against the route and the dev server answers with the SPA fallback HTML.

## Codex reset forecast

`SessionUsagePopover` is mounted per open tab and side chat, hidden ones included, and
`ProviderRow` per provider, so a mount-time fetch of the third-party forecast was a
request storm. Loading only when a user opens a surface, coalescing concurrent callers
onto one in-flight request, and clamping the served `Cache-Control: max-age` to 1m–5m
(the endpoint's CDN-shaped 4h is wrong for someone who just opened the panel) keep it to
roughly one 304 per interaction. Settings puts a stable read-only remaining-quota
summary, a flat direct Reset forecast action, and a Provider action menu in the row.
The action opens the existing forecast dialog in one step; there is no quota-details
interstitial repeating visible data. Forecast probabilities appear only in that
dialog, never beside the row's remaining-quota percentages. See the
[provider quota overview draft](../../specs/provider-quota-overview.md).
An always-visible composer band was rejected because it would have to load in the
background to know whether to render at all.

The parser also normalizes `scheduled_reset` independently of `active_watch`. Both entry
points and the dialog prioritize an announced schedule over the forecast probability.
The local scheduled time is optional; crossing it shows pending execution confirmation.
See the [API compatibility decision](../notes/implemented/bug-fix/2026-10-02-codex-scheduled-reset.md).
