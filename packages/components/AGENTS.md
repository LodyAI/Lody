# `@lody/components` contributor guidelines

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Root `AGENTS.md` also applies.

This package contains shared React UI for browser-shaped, Electron, and responsive
mobile surfaces.

## General rules

- Regenerate TanStack routes after changing route files.
- Add Storybook coverage for new presentational components and meaningful states.
- All user-visible copy must go through i18n.
- Prefer shared primitives from `src/components/ui` over private replacements.
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
- Workspace-level rooms without a machine owner use the platform fallback. Task rooms
  and the Task Index depend on this behavior; returning no transport silently disables
  task synchronization.
- Resource monitoring follows target ownership: local machines use the local monitor
  transport, remote machines use the optional remote transport, and unknown ownership
  remains pending.
- Presence is merged by origin. For an origin represented by the local plane, the local
  snapshot is authoritative, including absence; do not resurrect cleared presence from
  a lagging replica.

## Code Collab

- The owner-session file-index Flock is the file-tree and All Changes source. Machine
  RPC handles exact file content, save, LSP, and diff requests; it is not the file-index
  source of truth.
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
- Sidebar: `loro-sidebar.tsx`, `loro-app-sidebar.tsx`, and
  `sessions/session-list-rows.ts`. Sidebar rows are sessions, not Tasks.
- Agent configuration: `settings/agent-config-dialog.tsx` and
  `settings/env-vars-textarea.tsx`.
- Responsive mobile UI: `src/components/mobile/AGENTS.md`.
- Session UI: `src/components/sessions/AGENTS.md`.
- Tasks: `src/components/tasks/AGENTS.md`.
- Commands and shortcuts: `src/lib/commands/AGENTS.md`.
- Dialog-contained `OptionSelector` menus must portal into the nearest
  `[data-lody-dialog-content]`; a body portal is outside Radix remove-scroll handling.
- Keep optional three.js/R3F usage behind the lazy usage-calendar module so lightweight
  and SSR consumers do not evaluate its renderer graph.
