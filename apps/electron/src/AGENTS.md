# apps/electron/src

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Root `AGENTS.md` and `apps/electron/AGENTS.md` also apply. Build, packaging,
native-dependency, and OSS-composition rules stay in `apps/electron/AGENTS.md`.

## Module boundaries

- `src/main/index.ts` owns pre-application startup and the cloud desktop lease;
  `application.ts` owns lifecycle wiring, IPC registration and dependency injection.
  Keep credential stores and business imports behind the entry's dynamic import.
  Pre-ready APIs stay in `desktop-bootstrap`; buffer launch URLs before any await.
  Quit must retain ownership if the embedded CLI has not confirmed exit.
  Nightly reserves the CLI Host before application import and passes that identity
  to `CliService`; Worker stop/restart and control-only mode must not release it.
  Stable/local keep their existing external-runtime policy.
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

- Only factory-registered product windows may invoke product-window IPC. Dialogs,
  embedded browsers, navigation and close actions belong to their source window;
  auxiliary windows must not overwrite the primary window's persisted view state.

- Devbar is off by default; hidden Developer Mode enables it, while
  `LODY_DEVBAR=true` is automation only. Keep data in memory and MCP/Terminals
  behind `agentAccess`. GPU means process CPU/RSS, never hardware usage/VRAM.
  Runtime heap is approximate; only the startup override enables precise readings.

- Generic update metadata may carry localized Markdown under
  `vendor.lodyChangelog.locales.{en,zh_CN}` in addition to the standard English
  `releaseNotes` fallback. Main validates and bounds those remote strings before
  exposing them through `ElectronUpdaterState`; renderer code must use the shared
  safe Markdown renderer rather than raw HTML.
- React root callbacks persist fatal IPC diagnostics; ErrorBoundary owns caught-error
  UI and PostHog. Deduplicate errors; report mounted only from a committed layout effect.
  Keep hang capture local and bounded, Wait tied to active stalls, and stack opt-in
  limited to trusted product main frames.
  Contract: [renderer recovery](../../../specs/renderer-fatal-recovery.md).
- A CLI-armed reset (`lody app reset-cache`) is consumed once, before any window
  loads. `hard` is applied natively here because the renderer may not boot; `cache`
  is handed to the renderer exactly once, because only it can spare the Shortcut
  outbox and individual localStorage keys. Spec: `specs/desktop-local-reset.md`.
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
  An automatic login launch may suppress the initial product window, but onboarding and deep-link launches must remain visible during normal product use. Unpackaged E2E windows are the exception: they stay hidden unless `LODY_E2E_SHOW_WINDOW=1` and always disable background throttling.
- `sessionControl.send` streams intermediate responses on `sessionControl.response`
  keyed by request id. The renderer subscribes before `invoke`, removes the
  listener after settlement, and treats only the final response as completion.
- Before changing public-browser routing, isolation or its callers, read
  [the service boundary](main/services/AGENTS.md#public-browser).
- Image preview export (`services/image-export-service.ts`) keeps the native
  menu, clipboard, and save dialog here because the renderer holds the only copy
  of the image (a `blob:` URL main cannot download). Bytes cross once, after the
  menu selection. Naming/filter logic stays in `image-export-core.ts` so it runs
  under `node --test` without the `electron` runtime. `context-menu.ts` draws every
  other right-click and yields to it on images.

## Local file resources

- CLI `file/resolve-local` owns session/path resolution; Electron owns file IO. Never
  put local file bytes back into the daemon's JSON response or expose filesystem
  paths in resource URLs. `local-file-resource.ts` issues opaque renderer-lifetime
  capabilities, bounded per renderer, revoked on navigation/destruction.
- Each resource read opens a regular file without following a substituted symlink
  and checks device/inode/size/mtime/ctime before and during reads. Replacement or
  modification invalidates the preview; no mixing revisions or writes through resources.
- Text above the editor budget uses fixed bounded Range requests. Binary uses raw
  streams with backpressure/cancellation; raster header dimensions bound decode cost.
  The scheme never bypasses CSP, executes file content, or authorizes a remote RPC.
