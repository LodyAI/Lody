# `@lody/components` contributor guidelines

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Root `AGENTS.md` also applies.

This package contains shared React UI for browser-shaped, Electron, and responsive
mobile surfaces.

## General rules

- Regenerate TanStack routes after changing route files.
- Add Storybook coverage for new presentational components and meaningful states.
- All user-visible copy must go through i18n.
- Compact number units (K/M/B vs 万/亿) follow the product language via
  `toIntlLocaleOrEn` / `formatCompactNumber`, never the host OS locale.
- Prefer shared primitives from `src/components/ui` over private replacements.
- `src/lib/chat-workspace-geometry.ts` owns the bootstrap mathematical design grid
  for the authenticated Web chat workspace. Its current numeric grid is a reviewed
  reference, not evidence that the product was automatically inferred. Production
  layout stays ordinary Flex/Grid and exposes only stable geometry data markers;
  never turn its columns into
  component props or wrapper DOM. The Storybook fixture and Playwright gate
  consume the same spec. In development, `?geometry=1` adds the reference overlay
  for both the Sidebar-local and Main Pane grids, semantic alignment lines,
  spacing-rhythm diagnostics; none mounts in production or tests.
  Semantic alignment compares explicit control boxes: repeated slots may share
  an X-axis line across rows, while icon/text controls within one row may share a
  Y-axis instance. Cross-font rows use visual ink centers: text comes from the
  rendered font's actual ascent/descent metrics, SVGs from their transformed path
  bounds, and CSS shapes from their visible boxes. Typographic baselines compare
  text only; glyph weight and perceived balance remain CV concerns. Named groups
  expose stable member labels; diagnostics place guides at the median and assess the
  complete member spread, never DOM order. A measurable spread above tolerance but at
  most 1px is `sub-pixel-jitter`, stays folded in reports, and never enters the gate;
  larger spreads are violations. Groups below their required member count are
  `insufficient-evidence`, never aligned. Padding, margin, gap, and line-height multiples
  are spacing diagnostics, never alignment violations. Diagnostic debt remains
  non-blocking until a rule is explicitly promoted into the Playwright gate.
  Alignment-rail discovery is an earlier, heuristic stage. It mines repeated sibling
  subtrees from DOM topology and geometry; each repeated subtree instance contributes
  at most one member to a start/center/end rail, so a control and its nested icon cannot
  manufacture support. `data-geometry-discovery-scope` remains an optional hint for
  named or aggregate regions, never a prerequisite for discovery. Coordinate modes with
  repeated row support establish rails independent of DOM order before nearby singleton
  observations attach to the nearest mode; intermediate coordinates must not chain distinct
  indentation levels together. Discovery uses final rendered coordinates, not component
  structure or row-container boundaries, to infer multiple stable visual rails. Every candidate
  remains eligible for its nearest rail across the full scope; broad scans deliberately prefer
  an extra review candidate over silently excusing a shifted module or indentation level. Two
  repeated visible rows are sufficient to establish a local indentation rail; do not absorb a
  legitimate two-row visual level into a nearby rail merely because a broader rail has more support.
  A rail established by one rendered primitive kind accepts only that kind; cross-kind attachment
  requires mixed support on the rail itself so a coincidentally nearby icon is not judged by a text rail.
  Coordinate peaks merge only within the inlier tolerance. Two repeated peaks one CSS pixel apart are
  distinct visual levels; do not median them into one rail and report the smaller peak as misaligned.
  Members outside the inlier tolerance are reported as outliers, and confidence includes the
  rail's span relative to its containing scope rather than the minimum-span admission threshold. Flow
  text may contribute start/end edges but never a center rail because its box center changes
  with content and wrapping; center evidence comes from controls with an explicit geometry.
  Numeric text, including signed diff statistics, canonically uses its trailing edge so changing
  digit counts do not manufacture leading-edge outliers in right-aligned columns.
  Alignment discovery measures visible primitives in ink space: text through rendered `Range`
  bounds, SVGs through transformed path bounds, and images through their painted boxes. A padded
  control or container is a separate layout-box observation and must never cluster with an ink
  rail; spacing diagnostics own padding, margin, border, and gap measurements.
  Discovery must not read semantic-alignment attributes: it derives visual rows and their
  direct layout slots from ordinary DOM topology, including transparent hover controls that
  still occupy layout. It preserves each slot's start/center/end family until all captures
  choose one canonical anchor together. Contract inference samples every workspace
  verification viewport, caps normalized merging at 4 physical pixels, and counts missing
  scope observations in capture coverage. Rails with the same topology signature and
  normalized position across captures may become evidence-backed contract proposals. A
  discovered rail or proposal is not layout intent and cannot pass or fail the gate until
  a contract compiler binds it to stable
  semantic members and review promotes it into a named rule. Geometry-report capture covers
  the workspace Sidebar, the production-composed session right sidebar, and session states that
  materially change visible geometry; it does not duplicate an isomorphic conversation layout
  solely for a transient interaction such as mention drop.
  Violation images label every deviating member in place with its human-readable role, physical
  direction, measured offset, actual anchor, and a leader to the rendered element; a bare
  internal member id or an unlabelled shared line is not an actionable design finding.
  Discovery cards use product-region names rather than scope ids, count unique rendered
  elements rather than repeated anchor votes, and group one element's start/center/end
  offsets into one in-image annotation. Candidate rails stay visually subordinate to
  emphasized outliers because a heuristic proposal is not yet a violation. Report capture
  mode disables hover interaction and transitions, preserves explicit hover-action/rest
  swaps, and automatically reveals transparent containers that own interactive controls.
  Every measured control must therefore remain visible in both clean and annotated images
  without requiring business components to carry geometry-only markers.
- `ui/emoji-picker.tsx` is the shadcn `frimousse` registry component, with its
  two copy strings on i18n rather than the registry's inline English. Its dataset
  SHIPS WITH THE APP: `frimousse` otherwise fetches
  `${emojibaseUrl}/${locale}/{data,messages}.json` from a public CDN, which
  leaves the picker spinning forever in an offline desktop or mobile app. Every
  host build therefore registers `vite-emojibase-assets.ts` (see
  `apps/electron/electron.vite.config.ts`) and the picker reads
  `getBundledEmojibaseUrl()`. It is a URL contract, not an import — the library
  builds those paths at runtime, so a hashed `?url` asset cannot satisfy it, and
  a host that forgets the plugin gets an empty picker. Keep the locale list in
  the plugin and `lib/emojibase-assets.ts` in step; each locale is ~750 KB.
  The URL is anchored on the Vite BASE, never on `document.baseURI` alone: the
  router uses browser history over http, so the document URL is a deep route and
  resolving against it asks for `…/settings/emojibase`, which the dev server
  answers with the SPA fallback — the picker then parses HTML as JSON.
  Its search input also carries `focus-visible:shadow-none`. The global "Pro
  focus style" in `tailwind/index.css` puts an inset `--primary` ring on any
  focused input through a zero-specificity `:where(…)` selector, so every input
  with its own `focus-visible:` utility overrides it and never shows it; this
  bare registry input had none and was the one field in the app that did.
- A settings row (`settings/compact-layout.tsx`) is one grid: the label column takes the
  remaining space and the control column hugs its content. Never size either column from a
  viewport breakpoint — settings render in a panel far narrower than the window, and the
  panel clips its overflow, so a `md:`-width label column silently hides the control.
- An editable control fills with `bg-input-field`, never `bg-input`. `--input` is the
  theme's raw `input.background` and doubles as a muted chip/composer slab that may sit
  BELOW the page color in a light theme — a recessed gray field reads as disabled.
  `--input-field` (derived in `lib/vscode-theme/vscode-theme-css.ts` as the lighter of
  the field and page colors) keeps a dark theme's raised fill and lifts a light theme's
  field onto the page, where `--input-border` delimits it. Gray then means disabled
  (`disabled:bg-muted`), so keep that pair intact.
- `AgentActivityIndicator` animations stay CSS-only and compositor-friendly
  (`transform`/`opacity`). Do not restore canvas frame loops, React animation
  state, or timers; keep the Storybook Playwright render budgets passing.
- `ZoomableImageViewer` is the one image viewer, and it presents per surface:
  full-bleed on touch, a lightbox on desktop (inset photo, translucent mask, a
  top bar that clears the native window controls). Inset the photo with a
  transform only — `react-photo-view` positions the box it sized itself, so a
  capped `width`/`height` decenters it and padding erases a small image. Its
  portal sits at `--z-image-viewer`, deliberately UNDER `--z-toast`: the
  viewer's own copy/save confirmations are toasts.
- Image preview copy/save (`lib/image-preview-export.ts`) is Electron-only and
  splits by what each process can reach: main owns the native menu, clipboard,
  and save dialog; the renderer owns the `blob:` bytes and sends them only after
  the user picks an action. Copy re-encodes to PNG (the one format the system
  clipboard takes); save keeps the original encoding. Without the preload
  bridge the right-click must fall through to the browser's own menu.
- `PlatformContext` intentionally has no default. Cloud-shaped component tests use
  `tests/test-platform.tsx`'s `TestCloudPlatformProvider`; plain-module tests install
  and remove the exact platform port they need.
- Shared UI accesses optional hosted operations only through descriptors in
  `src/lib/cloud-api-operations.ts` and `@lody/platform/react`. Never import generated
  backend declarations or call a hosted database directly.
- A descriptor marked `public` can run before authentication and must expose only an
  intentionally public or narrowly token-scoped DTO.
- Renderer and worker builds that cannot use native top-level await must use
  `vite-top-level-await-fixed.ts`. Do not bypass its audited-version assertion.
- System theme state, persistence, and browser preference tracking are owned by
  `next-themes`. Keep Lody's wrapper focused on preview state, fixed VS Code theme
  application, and the Electron native-theme bridge.

## Crash surfaces

- The `ErrorBoundary` fallback (`error-boundary-fallback.tsx`) shows the real error
  text and a one-click copy of the full report on every build, not only in dev. A
  crash the user cannot read or copy is a crash we never hear about. Details default
  to visible; `showErrorDetails` is an opt-out, and the copy payload comes from the
  pure builder in `lib/error-boundary-report.ts`.
- Nothing on a crash screen reloads, restarts, or resets by itself. `resetKeys`
  recovery is bounded by `MAX_AUTOMATIC_RESETS` per repeating error, after which the
  fallback stays put, says it stopped retrying, and waits for a button press.
- `lib/clear-local-cache.ts` owns both recovery levels: `markCacheClearPending`
  (recoverable `lody*` caches, user stays signed in) and `startHardReset` (full local
  wipe plus sign-out, gated behind its own confirmation dialog). Both defer the
  asynchronous deletes to the next boot, because `deleteDatabase()` blocks while the
  runtime holds a connection. Clear synchronous storage BEFORE writing the boot flag.
- The cache clear also drops localStorage connection-state caches (Streams
  JWT/gateway, cursor-bypass markers, workspace-info map) via an explicit DELETE
  list — never a keep-allowlist, so a missed key survives a clear instead of a
  missed preference being wiped. Register new `lody:*` localStorage cache keys
  there; the auth token and preferences always survive a cache-level clear.
- `maybeClearLodyCacheOnBoot` runs at most once per page load and is shared by
  `AppInitializer` (so a user wedged before any workspace still gets the wipe) and
  `RuntimeProvider` (which must await it before opening the repo IndexedDB).
- `stuck-connection-banner.tsx` (mounted once in `MainLayout`) surfaces the same
  cache-clear flow after the control connection has been continuously `loading`
  for 45s. It is observational only: it must never interrupt, retry, or time out
  the connection attempt itself — a slow first sync completes exactly as it
  would without it.

## Workspace runtime

- `create-workspace-runtime.ts` maintains one Repo view. `WorkspaceTargetRouter` owns
  target ownership and transport selection; do not restore a second writer or a
  proxy-authoring/write-intent mirror.
- Transport state is selected per room, never merged. Runtime stores use
  `getReadinessTransportForRoom`; hooks without the router use the structural binding
  in `src/lib/room-readiness.ts`. Keep those selection rules aligned.
- The local renderer identity comes atomically from the Electron local-platform
  snapshot and uses the CLI catalog's persistent `local:*` id. Do not substitute a
  constant or temporary user.
- Controls for a machine resolved as local use Electron local session control,
  independent of cloud-token or sync state. A failed local bridge is an error; never
  fall back to a remote RPC path.
- Cloud Electron waits for the first **Run local agent** setting snapshot before
  creating its workspace runtime. Enabled uses dual sync; disabled uses cloud-only
  sync and must not attach the local data plane or surface its reconnect state.
- Workspace-level rooms without a machine owner use the platform fallback. Task rooms
  and the Task Index depend on this behavior; returning no transport silently disables
  task synchronization.
- Resource monitoring follows target ownership: local machines use the local monitor
  transport, remote machines use the optional remote transport, and unknown ownership
  remains pending.
- Presence is merged by origin. For an origin represented by the local plane, the local
  snapshot is authoritative, including absence; do not resurrect cleared presence from
  a lagging replica.
- Doc-metadata bootstrap and the live repo watch overlap by design: merge per field
  with live winning (`mergeBootstrapMetaCache`), never letting the snapshot undo an
  archive already applied live.

## Code Collab

- Remote file surfaces read the owner-session file-index Flock. An Electron surface whose
  target resolves to the local machine MUST load its initial file tree and All Changes from
  the local `code-collab/get-file-index` Machine RPC snapshot without waiting for the
  Flock; it then subscribes to local Flock events for later changes. A delayed or failed
  subscription must not block that initial IPC read or fall back to cloud RPC. The CLI
  asynchronously reconciles the initial snapshot back to Flock, so transient stale join
  events must be allowed to converge rather than treated as initial authority. Machine RPC
  also handles exact file content, save, LSP, and diff requests.
- **Opening a file to preview it is NOT a Code Collab operation.** `openFile` goes
  through File Preview v3, which the machine answers with a plain read — no workspace
  watch, no All Changes recompute, no Flock publish. A local Electron target uses the
  IPC-only `file/preview-local` method and MUST NOT fall back to Streams RPC while its
  route is unresolved; remote targets use the restricted `file/preview` method. It handles
  text and binary (PNG/JPEG/…) alike and is size-limited on the machine. So the file
  index is a HINT here, never a gate: a `binary` entry carries no `unavailableReason`
  (or the tree row goes unclickable via `canOpen` in
  `session-file-provider-view-model.ts`), and a path the index has never seen — an
  agent-produced temporary file, say — is still sent to the machine. Binary results
  must not enter the text open cache; that cache backs `save-text` conflict detection.
- Preview READS a wider path set than `save-text` WRITES (writes stay inside the session
  workspace). So a result with `external: true` must be forced readonly regardless of
  what the index says — otherwise the editor shows a Save button for a file the machine
  will refuse, and the user loses the edit at save time.
- Path provenance, skip-reason classification, and why file identity must come from the
  machine's reported path: [src/lib/AGENTS.md](src/lib/AGENTS.md).
- File-index rows must pass the shared Zod helpers. Preserve structured lazy-directory
  entries so `@file` completion can initialize a directory before refreshing results.
- Turn-scoped diffs come from the CLI-local evidence store. Do not synthesize them from
  the current disk or All Changes state, and do not restore the removed v1 diff capture.
- Keep real cross-render in-flight limits for file and diff reads. Active requests
  release their slots only when they settle.
- `DiffViewer` uses the shared `@pierre/diffs` worker pools for syntax work regardless
  of file size. Do not create or terminate a worker pool per viewer.

## Common entry points

- Chat landing: `src/components/chat/chat-landing.tsx`.
- Child-tab drafts send through the same accept unit as every other first
  message: `handleSendDraft` (`sessions/session-detail.tsx`) writes Session meta
  plus the first user turn together via `startSession` and only then promotes
  the draft tab; `requestSessionDispatch` is acceleration on top of the durable
  pointer. Never reintroduce a create-then-hand-off flow (pending-turn refs,
  post-mount ref flushes): a promoted tab must not exist before its first
  message is locally durable, and preserved composer text crosses the promotion
  via the input draft cache, not a component ref. `archiveSession` falls back to
  the rendered meta cache when the repo read lags hydration (a session the UI
  can show must be closable), and a close failure surfaces a toast — never a
  silent no-op.
- Sidebar: `loro-sidebar.tsx`, `loro-app-sidebar.tsx`, and
  `sessions/session-list-rows.ts`. Sidebar rows are sessions, not Tasks.
  EVERY desktop session row is a drag source for a session mention
  (`lib/session-mention-drag.ts`, dropped on the conversation page or the
  landing) — a new row renderer that omits it makes the gesture work in some
  lists and not others. Session tabs in `session-tab-bar.tsx` are the same
  gesture: parent tabs HTML5-drag, child session tabs arm the in-flight store
  from dnd-kit. `startSessionMentionDrag` / `armSessionMentionDrag` light
  `ConversationDropOverlay` immediately, before `dragenter`. A row whose surface is a navigation `<a>` overlay must
  put `draggable` on the ROW and `draggable={false}` on that anchor, or the
  browser starts a link drag instead.
  `SessionMeta.openedBySessionId` (a Session created BY another, e.g. the
  `lody_session_create` MCP tool) indents that row under its opener via
  `lib/session-opened-by-tree.ts`. EVERY session list uses it — `session-list.tsx`
  groups, the local-project sections, and `sidebar-updated-session-list.tsx`
  (which renders both the Updated bucket and the Pinned section) — plus
  `sidebar-navigation-model.ts`, so keyboard nav matches what is rendered.
  It is presentation only and is NOT `parentSessionId`: opened Sessions keep
  their own workspace/lifecycle and stay first-class rows, while
  `parentSessionId` children never reach the sidebar at all (`sessionListAtom`),
  so nothing can nest twice. TWO fields, and they must not be merged:
  `openedBySessionId` is the PRECISE opener and drives navigation;
  `openedByRowSessionId` is the sidebar ROW to indent under. They differ when an
  agent inside a child Tab creates a Session — the Tab has no row, so
  `buildSidebarOpenerRowResolver` (`sessions/session-list-rows.ts`) walks
  `parentSessionId` up to the root row. Never "simplify" that by rewriting
  `openedBySessionId` to the root: "Go to Opener Session" and the conversation's
  "Opened by" entry must still land on the exact Tab that created the Session.
  The opener and unrelated top-level rows keep the exact flat-list alignment.
  The shared leading slot owns the node-centre affordance: an idle opener shows
  its disclosure at rest and swaps it for ⋯ on row hover; an idle child shows
  ├/└ and swaps those for ⋯ in the SAME 7px-centred position. STATUS OUTRANKS
  THE TREE on both sides: an active (working / unread / waiting) child drops
  the trunk and elbow, and an active opener drops its disclosure — that node
  shows only the status, never both. Gate the opener on the whole activity set,
  not just `isWorking`: the disclosure branch REPLACES the indicator, so an
  unread opener would otherwise render a chevron and lose its unread dot. The
  context menu's expand/collapse item is what keeps a busy opener foldable, so
  it must stay wired. Only a child widens that slot
  from 14px to 26px, producing the 12px title indent without shifting the row
  background. Keep connector geometry in `sidebar-row-shared.tsx`, and keep the
  opener's context menu expand/collapse item wired to the same toggle callback.
  The resolver needs `allActiveSessions` (the only view that still contains
  child Tabs), so any new list must take it from the sidebar rather than
  re-deriving it from rows. Nesting is then resolved INSIDE one rendered list,
  which is what keeps section boundaries intact: a pinned opener and an unpinned
  opened Session are in different arrays, so both stay top-level. The tree never
  hides a Session — a missing, cross-section, cross-group, cycling, or
  deeper-than-one-level opener degrades to a top-level row; the preview cap
  (`MAX_VISIBLE_SESSIONS` / `SHOW_FULL_BUCKET_THRESHOLD`) counts top-level rows.
  Every list here is sorted by latest activity, so each surface passes `rootRank`
  and an opener is ranked by its FRESHEST opened Session — without it, nesting
  would bury a just-updated row under a stale opener and silently break the
  ordering contract of Updated mode. Collapse state is the shared
  `sidebarCollapsedOpenedBySessionsAtom` and defaults to EXPANDED. Both
  navigation directions must stay reachable: the tree and the row context menu's
  "Go to Opener Session" in every sidebar list, `SessionHeaderMenu.openedByRelations`,
  and the in-conversation cards for successful create Operations / the opened
  Session's precise opener. The mobile chat lists render the same tree from the
  same two fields, per bucket, minus the disclosure — see `mobile/AGENTS.md`.
  Session lifecycle actions traverse both relations: a root archive, restore,
  or delete includes child Tabs and every independently opened descendant.
  Child Tabs share the root's machine lifecycle command; independently opened
  Sessions enqueue their own. The archive list keeps the opened-by indentation
  while child Tabs remain inside their owning Session's archived-tab UI.
- Desktop update prompt: `sidebar-update-banner.tsx` plus `update-changelog-dialog.tsx`,
  driven by the pure selectors in `lib/electron-update-banner.ts`. The changelog opens
  in-app; release notes come from a remote feed and render as sanitized Markdown with
  raw HTML off. The website is only the no-notes fallback, through `getChangelogUrl`
  and `openExternalUrl`, never a hardcoded link.
- Agent configuration: `settings/agent-config-dialog.tsx` and
  `settings/env-vars-textarea.tsx`.
- Codex reset forecast: `components/codex-reset/` + `lib/codex-reset-forecast*.ts`.
  A public unauthenticated GET to the third-party `codex-resets.com`, cached in ONE
  module-level store (`lib/codex-reset-forecast-store.ts`) that every surface shares.
  **Nothing loads on mount.** A request happens only when a user OPENS a surface
  that shows the forecast — the settings provider row's chip (the click that opens
  the dialog) and the composer's usage popover (Radix mounts its content on open,
  so `CodexResetForecastUsageRow` loads from its own mount). `useCodexResetForecast`
  therefore has no load effect; call `revalidate()` from the interaction. Never
  attach credentials, and never fetch per component: `SessionUsagePopover` is mounted
  per open tab AND side chat (hidden ones included) and `ProviderRow` per provider,
  so a mount-time fetch was a request storm. Concurrent callers coalesce onto one
  in-flight request; freshness is the served `Cache-Control: max-age` clamped to
  1m–5m — the endpoint's CDN-shaped 4h is wrong for someone who just opened the
  panel — and a lapsed TTL revalidates with `If-None-Match`, so the usual outcome is
  a 304. `data` survives a revalidation, which is what gives stale-while-revalidate
  for free — never blank it on refresh. Gate every entry point on
  `canShowCodexResetForecast` (built-in Codex with no custom key/brand, matching
  `canShowSubscriptionRateLimits`); a disabled entry makes no request at all. The
  provider row always shows the entry; the usage-popover row appears only while a
  watch is live. There is deliberately NO always-visible composer band: it would
  have to load in the background to know whether to render. That popover row must
  NOT own the dialog — opening a Radix Dialog from inside a Popover dismisses the
  popover and unmounts a dialog rendered in its content, so `SessionUsagePopover`
  renders `CodexResetForecastDialogHost` as a sibling of the popover instead.
  `forecast_window` is FREE TEXT, not a timestamp ("the next 6 hours", "later today").
  Do not show that untranslated phrase as the forecast time: render the absolute UTC
  `expires_at` instant semantically ("Today 2:00 PM", "明天 14:00") in the user's
  browser/OS time zone, and describe it as the time through which the forecast is valid
  rather than promising a reset.
- Responsive mobile UI: `src/components/mobile/AGENTS.md`.
- A pending local-project removal is a visible lifecycle state, not an absent
  project: keep the project and its existing Sessions discoverable while the
  owning machine is offline or retrying, but exclude it from new-Session
  selectors. Once the catalog row is gone, archived Sessions remain readable
  and deletable; Restore stays unavailable until the same local project is
  added again.
- Local-project removal may optionally clean Lody-created Session worktrees, but
  the option defaults off and is available only after the owning machine
  preflights every worktree. Always state that the original project directory is
  never deleted; list dirty worktrees and keep them by default. A completed
  cleanup result is not pending removal and must be acknowledged visibly even
  when some worktrees were kept or failed.
- Session UI: `src/components/sessions/AGENTS.md`.
- Tasks: `src/components/tasks/AGENTS.md`.
- Commands and shortcuts: `src/lib/commands/AGENTS.md`.
- Dialog-contained `OptionSelector` menus must portal into the nearest
  `[data-lody-dialog-content]`; a body portal is outside Radix remove-scroll handling.
- Keep optional three.js/R3F usage behind the lazy usage-calendar module so lightweight
  and SSR consumers do not evaluate its renderer graph.
