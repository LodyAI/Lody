# Electron contributor guidelines

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Root `AGENTS.md` also applies.

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

## Local OSS composition

- The public desktop composition is local-only. It must not discover deployment env
  files, initialize authenticated product-cloud behavior, or enable telemetry.
- The build-time `mainPlatformKind` is the source of truth for data directories,
  sockets, run/lock files, host leases, and workspace catalogs. Pass it explicitly;
  never infer it from an inherited `LODY_PLATFORM` value.
- The Vite toolchain mode is named `oss`, while the injected product platform remains
  `VITE_LODY_PLATFORM=local`. `electron.vite.config.ts` owns this mapping and must
  clear caller-provided `VITE_*` values before injecting audited local constants.
- Run desktop development from the repository root with `pnpm start:local`. It must
  rebuild the embedded CLI and local renderer before launching the bundled CLI; do
  not reuse production/cloud artifacts.
- Cloud desktop development must likewise build and sync the CLI before
  `electron-vite dev`; the direct `apps/cli/dist` lookup is only a missing-staging
  fallback and must not let an older `resources/cli` shadow a fresh build.
- Turning off **Run local agent** is an explicit cloud control-only mode: do not
  probe an embedded or externally started CLI, and keep the local Loro data-plane
  relay disconnected until the setting is enabled again.
- `localPlatform.getSnapshot` atomically supplies the persistent `local:*` user and
  the single `lw_*` workspace from the CLI catalog. Do not split this into independent
  fallbacks. A missing catalog means provisioning; malformed identities or multiple
  active workspaces are errors.
- OSS local mode must not create a PostHog client, write an analytics install id, or
  upload source maps, even when unrelated analytics variables exist in the shell.

## Renderer and window integration

- Electron 39's Chromium supports native top-level await. Keep renderer and module
  worker builds on native TLA; do not add `vite-plugin-top-level-await` or an
  equivalent full-bundle AST compatibility rewrite. Reprocessing Rollup's complete
  output graph materially increases production renderer peak memory.
- Linux window identity is one contract: the composition's packaged `desktopName`,
  electron-builder's `syncDesktopName`, the pre-ready `app.setDesktopName` value,
  and the AppImage runtime desktop entry must all resolve to the same desktop-file
  basename. KDE uses that identity to associate Wayland/X11 windows with the
  installed icon.
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
- The onboarding window must be native Light before its first renderer paint; normal product windows start from the System theme source.
  Windows title-bar geometry must stay aligned across
  `MAIN_WINDOW_TITLE_BAR_OVERLAY_HEIGHT`, the `h-9` drag strip in
  `routes/__root.tsx`, and the `pt-9` offset in `web-workspace-layout.tsx`.
- `sessionControl.send` streams intermediate responses on `sessionControl.response`
  keyed by request id. The renderer subscribes before `invoke`, removes the
  listener after settlement, and treats only the final response as completion.
- Image preview export (`services/image-export-service.ts`) keeps the native
  menu, clipboard, and save dialog here because the renderer holds the only copy
  of the image (a `blob:` URL main cannot download). Bytes cross once, after the
  menu selection. Naming/filter logic stays in `image-export-core.ts` so it runs
  under `node --test` without the `electron` runtime.
- Use `pnpm --dir apps/electron preview:local` only when a smoke/E2E harness has
  already prepared and validated the OSS build artifacts. That low-level command must
  remain `--skipBuild --mode oss`.

## Embedded CLI and native dependencies

- The embedded CLI launches built JavaScript only; there is no source-loader/Jiti
  fallback. Development and packaged builds must use the same output layout.
- `better-sqlite3`, `@lydell/node-pty`, and `loro-crdt` remain external and must be
  staged under `resources/cli/node_modules` by `scripts/sync-cli-dist.mjs` and
  `scripts/cli-native-deps.mjs`.
- `@lydell/node-pty` and `better-sqlite3 >= 13.0.2` use N-API artifacts. Stage the
  target platform/architecture artifact; do not rebuild by Electron ABI.
- Every embedded-CLI descendant launched through `process.execPath` must inherit
  `ELECTRON_RUN_AS_NODE` when it exists. On packaged macOS, omitting it launches a
  second GUI app instead of Node.
- Electron Builder ignores nested staged `node_modules`. `eb-after-pack.mjs` must copy
  them into `app.asar.unpacked`, assert the DeepSeek adapter plus all four pinned
  presets, then probe CLI `--help`, node-pty loading, and a real in-memory SQLite
  database before signing.
- Keep `better-sqlite3 >= 13.0.2`, CLI `engines.node >= 22.14.0`, the first-import
  guard in `sqlite-runtime-support.ts`, and its tests aligned. Older Node versions can
  segfault while loading the N-API 10 binding. Linux armv7 is unsupported.
- When upgrading `@lydell/node-pty`, audit package layout and Windows ConPTY binding
  names. Apply the staged asar-path repair after downloading target artifacts; a pnpm
  patch cannot cover cross-architecture packages fetched during packaging.
- `electronLanguages` must include underscore names used by macOS resources and
  hyphenated names used by Chromium `.pak` files. The after-pack assertion for
  `locales/en-US.pak` is a release gate.

## Release packaging and auto-update

- Always package through `scripts/package-electron.mjs` (`pnpm run package -- <args>`),
  never `electron-builder` directly. It injects the released version via
  `extraMetadata` so `package.json` is a fallback rather than the release source of
  truth, and it forces `--publish never` unless a caller opts in.
- The `publish` block in `electron-builder.yml` is what gives the public build an
  update feed: `electron.vite.config.ts` strips every `VITE_*` value, so
  `AppUpdaterService` finds no `VITE_ELECTRON_UPDATE_URL` and falls back to the
  packaged `app-update.yml`. That block is also what makes electron-builder emit
  `latest*.yml` at all. Its tag contract is `v${version}`.
- Artifact names must stay space-free. GitHub Releases rewrites spaces in uploaded
  asset names to periods, which would desynchronize them from the names recorded in
  `latest*.yml`. Do not reintroduce `${productName}` into an `artifactName`.
- macOS releases must be signed and notarized. Squirrel.Mac will not install an update
  it cannot validate against the running app's signature, so an unsigned macOS build
  silently has no working auto-update. Windows and Linux do not have this constraint.
- CI packages Linux as `AppImage deb` only; `snap` stays in the target list for local
  builds because it needs snapcraft on the machine.

## Verification

- Run the repository checks after source changes. Packaging/native-dependency changes
  also require the Electron packaging probes for every affected target architecture.
- Do not replace deterministic probes with launch sleeps or retry-only tests.
