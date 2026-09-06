# apps/electron/src

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Root `AGENTS.md` and `apps/electron/AGENTS.md` also apply. Build, packaging,
native-dependency, and OSS-composition rules stay in `apps/electron/AGENTS.md`.

## Module boundaries

- `src/main/index.ts` owns Electron lifecycle hooks, event wiring, IPC registration,
  and dependency injection. Keep business logic out of it.
- Put domain services in `src/main/services/*`, IPC handlers and input validation in
  `src/main/ipc/*`, and local-project worker/storage code in
  `src/main/local-project/*`.
- Main-process-only helpers belong in `src/main/utils.ts`. Put cross-runtime types and
  pure logic in `@lody/shared`; shared Electron IPC contracts live in the narrow
  `@lody/shared/electron-ipc` export.
- Electron main and preload code must not import runtime values from the
  `@lody/shared` root barrel. Use a narrow subpath so Node bundles do not pull in
  renderer modules or `loro-crdt` WASM.
- Invoke signatures come from the `IpcService` classes and the one constructor list in
  `register-services.ts`; every public instance method is renderer-facing and must have
  `@IpcMethod()`. Do not restore parallel handwritten invoke contracts or per-method
  preload lists. `packages/components` intentionally imports the inferred service type
  across the app/package boundary with `import type`; the import is erased and must never
  become a runtime dependency. Shared push/send maps remain in
  `@lody/shared/electron-ipc`. Preload exposes only `{ invoke, on, send }`, permits invoke
  channels by the service groups in `preload/ipc-invoke-policy.ts`, and keeps push/send
  allowlists. The IPC registration test keeps that policy aligned with the registered
  service constructors. There is no `window.api`. Validate foreign input at the IPC class
  boundary.
- Preload runs under the renderer CSP. Zod schemas used there must pass
  `{ jitless: true }`; do not add `unsafe-eval` to accommodate Zod's JIT path.

## Renderer and window integration

- Generic update metadata may carry localized Markdown under
  `vendor.lodyChangelog.locales.{en,zh_CN}` in addition to the standard English
  `releaseNotes` fallback. Main validates and bounds those remote strings before
  exposing them through `ElectronUpdaterState`; renderer code must use the shared
  safe Markdown renderer rather than raw HTML.
- React render failures are split by owner: the root `createRoot` error callbacks
  persist fatal IPC diagnostics, while `ErrorBoundary` owns caught-error UI and
  PostHog reporting. De-duplicate the same error across React and window events.
  Renderer-mounted notification must come from a committed layout-effect sentinel,
  never a timer or microtask guess.
- Theme changes must also update the native window color in `window-theme.ts`.
  OS appearance changes while `themeSource` is `system` must retint chrome and
  notify the renderer (`app.nativeTheme`). On macOS also subscribe
  to `AppleInterfaceThemeChangedNotification`; Chromium `matchMedia` and
  `nativeTheme.updated` often miss Control Center switches.
- Frameless window drag is per-panel, not a root overlay: each column's top
  header (or a same-height `WindowDragStrip` when there is no header) is
  `-webkit-app-region: drag`. Interactive descendants use `app-region-no-drag`.
  Dialog and alert-dialog overlays mount the strip themselves. Hide those
  regions in native fullscreen. Windows caption buttons stay an OS overlay
  (`MAIN_WINDOW_TITLE_BAR_OVERLAY_HEIGHT`); right-edge headers pad `pr-[144px]`
  so toolbar controls do not sit under them.
- The onboarding window must be native Light before its first renderer paint; normal product windows start from the System theme source.
  An automatic login launch may suppress the initial product window, but onboarding and deep-link launches must remain visible.
- `sessionControl.send` streams intermediate responses on `sessionControl.response`
  keyed by request id. The renderer subscribes before `invoke`, removes the
  listener after settlement, and treats only the final response as completion.
- The public browser (`services/public-browser-service.ts`) has NO network guard:
  no resolver check, no per-request hostname policy — only engine routing, so a
  loopback address is refused here and sent to Managed Preview. The view is a
  sandboxed `WebContentsView` with no preload, script injection, page capture,
  or agent-facing tool; the only reader of what it renders is the person looking
  at it, so it is strictly less capable than the user's own Chrome and a guard
  protects nothing. The one it used to have blocked every fake-IP proxy user.
  Engine routing is a check on the hostname TEXT: a public name that RESOLVES to
  loopback (`localtest.me`) still renders here, showing this machine's loopback
  rather than the agent's. Do not describe the split as resolution-accurate — it
  is a routing miss, not an exposure, and closing it means resolving every
  hostname again.
  Two triggers require bringing a guard back, and both are about who is on the
  other end, not about the address. A non-human READER — agent DOM access,
  screenshots, a preload bridge — makes rendered content exfiltratable. A
  non-human NAVIGATOR already exists: a Managed Preview page is agent-authored
  and can post navigation requests to the panel, so `session-browser-panel.tsx`
  refuses private-LAN destinations from page content. Keep that refusal on the
  panel side; this process cannot tell the two sources apart.
  The engine-routing check runs on `will-navigate` AND `will-redirect`, like
  `installNavigationGuard` in `window.ts`: `will-navigate` does not fire for a
  server-side 3xx, so a public page redirecting to loopback would otherwise
  commit here and never reach Managed Preview.
- Image preview export (`services/image-export-service.ts`) keeps the native
  menu, clipboard, and save dialog here because the renderer holds the only copy
  of the image (a `blob:` URL main cannot download). Bytes cross once, after the
  menu selection. Naming/filter logic stays in `image-export-core.ts` so it runs
  under `node --test` without the `electron` runtime.
