# `@lody/components` contributor guidelines

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Root `AGENTS.md` also applies.

This package contains shared React UI for browser-shaped, Electron, and responsive
mobile surfaces. Background for the rules below:
[.agents/docs/components-package.md](../../.agents/docs/components-package.md).

## General rules

- Regenerate TanStack routes after changing route files.
- Add Storybook coverage for new presentational components and meaningful states.
- All user-visible copy must go through i18n.
- Compact number units (K/M/B vs 万/亿) follow the product language via
  `toIntlLocaleOrEn` / `formatCompactNumber`, never the host OS locale.
- Prefer shared primitives from `src/components/ui` over private replacements. Editable
  controls fill with `bg-input-field`, never `bg-input`; gray means disabled
  (`disabled:bg-muted`). Primitive rules: [src/ui/AGENTS.md](src/ui/AGENTS.md).
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

- The `ErrorBoundary` fallback (`error-boundary-fallback.tsx`) shows the real error text
  and a one-click copy of the full report on every build, not only in dev. Details
  default to visible; `showErrorDetails` is an opt-out, and the copy payload comes from
  the pure builder in `lib/error-boundary-report.ts`.
- Nothing on a crash screen reloads, restarts, or resets by itself. `resetKeys` recovery
  is bounded by `MAX_AUTOMATIC_RESETS` per repeating error, after which the fallback
  stays put, says it stopped retrying, and waits for a button press.
- `lib/clear-local-cache.ts` owns both recovery levels: `markCacheClearPending`
  (recoverable `lody*` caches, user stays signed in) and `startHardReset` (full local
  wipe plus sign-out, gated behind its own confirmation dialog). Both defer the
  asynchronous deletes to the next boot, because `deleteDatabase()` blocks while the
  runtime holds a connection. Clear synchronous storage BEFORE writing the boot flag.
- The cache clear also drops localStorage connection-state caches (Streams JWT/gateway,
  cursor-bypass markers, workspace-info map) via an explicit DELETE list — never a
  keep-allowlist. Register new `lody:*` localStorage cache keys there; the auth token
  and preferences always survive a cache-level clear.
- The copy payload also carries the tail of `lib/session-render-trace.ts`, a
  module-level ring of session render/mount/navigation lines (consecutive duplicates
  collapse into ×N). Diagnostics only: writers append one compact line and must never
  read the trace to drive behavior; the surface mount/unmount lines use a LAYOUT effect
  because passive effects may never flush inside the crashing cascade.
- `maybeClearLodyCacheOnBoot` runs at most once per page load and is shared by
  `AppInitializer` (so a user wedged before any workspace still gets the wipe) and
  `RuntimeProvider` (which must await it before opening the repo IndexedDB).
- `stuck-connection-banner.tsx` (mounted once in `MainLayout`) surfaces the same
  cache-clear flow after the control connection has been continuously `loading` for 45s.
  It is observational only: it must never interrupt, retry, or time out the connection
  attempt itself.

## Code Collab

- Remote file surfaces read the owner-session file-index Flock. An Electron surface
  whose target resolves to the local machine MUST load its initial file tree and All
  Changes from the local `code-collab/get-file-index` Machine RPC snapshot without
  waiting for the Flock; it then subscribes to local Flock events for later changes. A
  delayed or failed subscription must not block that initial IPC read or fall back to
  cloud RPC. The CLI asynchronously reconciles the initial snapshot back to Flock, so
  transient stale join events must be allowed to converge rather than treated as initial
  authority. Machine RPC also handles exact file content, save, LSP, and diff requests.
- **Opening a file to preview it is NOT a Code Collab operation.** `openFile` goes
  through File Preview v3, which the machine answers with a plain read — no workspace
  watch, no All Changes recompute, no Flock publish. A local Electron target uses the
  IPC-only `file/preview-local` method and MUST NOT fall back to Streams RPC while its
  route is unresolved; remote targets use the restricted `file/preview` method. It
  handles text and binary (PNG/JPEG/…) alike and is size-limited on the machine, but
  that limit is the REMOTE wire's: the local path reads to
  `FILE_PREVIEW_V3_LOCAL_LIMITS`, derived from the 16 MiB local-IPC response cap. Every
  preview answers in ONE bounded response, which is also the ceiling on the remote
  `Download file` action.
- The file index is a HINT here, never a gate: a `binary` entry carries no
  `unavailableReason` (or the tree row goes unclickable via `canOpen` in
  `session-file-provider-view-model.ts`), and a path the index has never seen — an
  agent-produced temporary file, say — is still sent to the machine. Binary results must
  not enter the text open cache; that cache backs `save-text` conflict detection.
- Preview READS a wider path set than `save-text` WRITES (writes stay inside the session
  workspace). So a result with `external: true` must be forced readonly regardless of
  what the index says, or the user loses the edit at save time.
- File-index rows must pass the shared Zod helpers. Preserve structured lazy-directory
  entries so `@file` completion can initialize a directory before refreshing results.
- Turn-scoped diffs come from the CLI-local evidence store. Do not synthesize them from
  the current disk or All Changes state, and do not restore the removed v1 diff capture.
- Keep real cross-render in-flight limits for file and diff reads. Active requests
  release their slots only when they settle.
- Path provenance, skip-reason classification, and why file identity must come from the
  machine's reported path: [src/lib/AGENTS.md](src/lib/AGENTS.md).

## Scoped rules

- Product surfaces, sidebar session rows, local projects:
  [src/components/AGENTS.md](src/components/AGENTS.md).
- Shared primitives, emoji picker, field colors, diff viewer:
  [src/ui/AGENTS.md](src/ui/AGENTS.md).
- Hooks: [src/hooks/AGENTS.md](src/hooks/AGENTS.md). Workspace runtime, transports, and
  presence: [src/providers/AGENTS.md](src/providers/AGENTS.md).
- Sessions, mobile, chat, mentions, tasks, onboarding, settings, and Codex reset
  forecast each own an `AGENTS.md` under `src/components/`. Commands and shortcuts:
  [src/lib/commands/AGENTS.md](src/lib/commands/AGENTS.md).
