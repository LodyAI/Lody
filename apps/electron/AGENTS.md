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
- Define or extend the shared IPC contract before adding an IPC handler. Validate all
  foreign input at the process boundary.
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
- `local-platform:get-snapshot` atomically supplies the persistent `local:*` user and
  the single `lw_*` workspace from the CLI catalog. Do not split this into independent
  fallbacks. A missing catalog means provisioning; malformed identities or multiple
  active workspaces are errors.
- OSS local mode must not create a PostHog client, write an analytics install id, or
  upload source maps, even when unrelated analytics variables exist in the shell.

## Renderer and window integration

- React render failures are split by owner: the root `createRoot` error callbacks
  persist fatal IPC diagnostics, while `ErrorBoundary` owns caught-error UI and
  PostHog reporting. De-duplicate the same error across React and window events.
  Renderer-mounted notification must come from a committed layout-effect sentinel,
  never a timer or microtask guess.
- Theme changes must also update the native window color in `window-theme.ts`.
  Windows title-bar geometry must stay aligned across
  `MAIN_WINDOW_TITLE_BAR_OVERLAY_HEIGHT`, the `h-9` drag strip in
  `routes/__root.tsx`, and the `pt-9` offset in `web-workspace-layout.tsx`.
- `lodySessionControl:send` streams intermediate responses on the fixed IPC event
  channel keyed by request id. Preload subscribes before `invoke`, removes the
  listener after settlement, accepts the legacy single-JSON response, and treats only
  the final response as completion.
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
  them into `app.asar.unpacked`, then probe CLI `--help`, node-pty loading, and a real
  in-memory SQLite database before signing.
- Keep `better-sqlite3 >= 13.0.2`, CLI `engines.node >= 22.14.0`, the first-import
  guard in `sqlite-runtime-support.ts`, and its tests aligned. Older Node versions can
  segfault while loading the N-API 10 binding. Linux armv7 is unsupported.
- When upgrading `@lydell/node-pty`, audit package layout and Windows ConPTY binding
  names. Apply the staged asar-path repair after downloading target artifacts; a pnpm
  patch cannot cover cross-architecture packages fetched during packaging.
- `electronLanguages` must include underscore names used by macOS resources and
  hyphenated names used by Chromium `.pak` files. The after-pack assertion for
  `locales/en-US.pak` is a release gate.

## Verification

- Run the repository checks after source changes. Packaging/native-dependency changes
  also require the Electron packaging probes for every affected target architecture.
- Do not replace deterministic probes with launch sleeps or retry-only tests.
