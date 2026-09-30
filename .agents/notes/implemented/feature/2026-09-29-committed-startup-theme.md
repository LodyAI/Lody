# Open native surfaces on the committed theme

Status: implemented
Translation: current

[中文](2026-09-29-committed-startup-theme.zh.md)

## Abstract

A user on Lody's dark theme under a light operating system opened a desktop
window whose native frame, background and Windows caption buttons were white
around a dark page, because the main process chose them from the OS appearance:
the theme lives in the renderer's `localStorage`, which main cannot read. The
renderer now mirrors the theme the user committed — never a hover preview — into
a main-process settings file that feeds `nativeTheme.themeSource` before the
window exists, and publishes the same value through a bridge that native mobile
shells implement. Opening that file must never be able to stop the app from
launching, so every startup `conf` store now degrades to in-memory defaults when
its file is malformed. The in-page first frame is not part of this decision; the
[boot shell](2026-09-26-boot-shell-first-paint.md) already paints it in the
stored theme.

## Decision and evidence

- **Committed, not previewed.** `ThemeProvider` writes `storedTheme`, which is
  `useNextTheme().theme`. next-themes 0.4.6 applies `forcedTheme` only to the
  document class and never to the returned `theme`, so a Settings preview cannot
  reach persistence. The renderer calls `app.setNativeTheme` for live chrome
  (which follows previews) and `app.setStartupThemeSource` for the next launch;
  both validate the source at the IPC boundary.
- **Before the window, not after.** `getInitialMainWindowThemeSource` returns the
  stored source for product windows and keeps onboarding pinned to Light. When
  nothing has been committed yet, it returns `system`, the previous behavior.
- **Mobile shells.** `LodyStartupThemeBridge` (`window.__LODY_STARTUP_THEME__`)
  is typed here and implemented by the private shell, which colors its splash
  and WebView from its own storage.
- **Launch must survive a bad file.** `conf` 15.1.0 reads and validates inside
  its constructor with `clearInvalidConfig` defaulting to `false`; a truncated
  file throws `SyntaxError` and an out-of-enum value throws `Config schema
  violation:`, both measured against real files. Every store is built at import
  or at startup, so the throw aborted launch. `createSettingsStoreWithFallback`
  now wraps the theme, auto-launch, onboarding, window-state and global-shortcut
  stores; `auth.ts` keeps its own backup path and app-icon preferences already
  clear invalid files lazily. In-memory defaults were chosen over
  `clearInvalidConfig: true` so the damaged file stays on disk for recovery and
  unreadable paths are covered too. A corrupt `onboarding-state.json` therefore
  shows onboarding again rather than failing to start.
- **Login warm-up.** The login page calls `preloadMainLayout()` on an idle
  callback instead of a bare `import()`. That records the module, so
  `PreloadedMainLayout` mounts it without suspending into the boot shell for a
  commit. A rejected warm-up is not cached, so the real mount retries. On web and
  mobile this is a request `/login` did not previously make, paid also by visitors
  who never sign in; it is not gated on a sign-in click because a social login
  navigates away immediately.

## Alternatives rejected

- A preload script applying `.dark` from a launch argument. The boot shell's
  CSP-hashed head script reads `localStorage` directly and is not fixed for the
  window's lifetime.
- Reading the renderer's storage from main. The Chromium profile's leveldb is not
  a supported interface.

## Verification and limits

`node --test` covers source resolution, IPC-boundary validation and the fallback
against real corrupt files; ablating the fallback fails both corruption cases.
Vitest covers the committed-versus-preview split and the warm-up retry. The
Windows caption overlay on first frame was not observed on a Windows machine; it
is argued from `applyResolvedWindowTheme`, which already drives it on change.
Hard-coded native colors are not yet bound to the themes' `--background`: the
light window background is `#FFFFFF` while the page is `#F9F9F9`.

PR: [#320](https://github.com/LodyAI/Lody/pull/320)
