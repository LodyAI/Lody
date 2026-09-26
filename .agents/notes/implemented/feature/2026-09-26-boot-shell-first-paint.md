# The window's first frame is the boot shell

Status: implemented
Translation: current

[中文](2026-09-26-boot-shell-first-paint.zh.md)

## Abstract

Every loading state Lody had was drawn by React, so until the renderer bundle had
downloaded, executed and committed, a window showed an empty canvas; on a slow load
that was several seconds of nothing, followed by a differently shaped placeholder,
followed by the real layout. The window's first frame is now a static boot shell
inlined into `index.html`: the sidebar column at the user's stored width and theme,
and the Lody mark centred in the content area. React's boot and auth gates render
the same markup, so the only visible change is the real layout arriving. The cost is
a small inline script that needs a CSP hash, and colours copied out of the bundled
themes, which a test pins.

## Problem

Nothing React draws exists before the first commit. `LoadingPlaceholder`, the
lazily loaded layout's `CriticalWorkspaceShell` and the boot-failure card only cover
what comes after it. Before that, `#root` is empty, and on a slow load it stays empty
while the entry chunk, i18n and the router come up. A recording of a desktop reload
with every script and stylesheet delayed by 1.5 s shows about 5.7 s of blank canvas,
then `CriticalWorkspaceShell` (a 220 px sidebar with text rows, where the real one is
280 px), then the real layout: three different frames.

The entry stylesheet makes this worse on the web: Vite links it in `<head>`, where it
blocks the first paint until the whole product stylesheet has downloaded, so even
markup in `index.html` would not show before it.

## Decision

- **One frame, drawn twice.** `lib/boot-shell.ts` owns the markup, stylesheet and
  colours; `lib/boot-shell-script.ts` owns the boot script, import-free so the
  desktop CSP test can hash it under Node. `vite-boot-shell.ts` inlines them into entries that carry
  the `<!-- lody:boot-shell-head -->` and `<!-- lody:boot-shell -->` markers.
  `components/boot-shell.tsx` renders the same markup from React. React's first
  commit replaces the static copy inside `#root`, and the two are identical, so that
  swap is invisible. A test compares the two outlines and the mark element byte for byte.
- **Only what is certain.** The shell draws the sidebar column (no rows) and the
  mark. Rows, headings or a composer would be guesses that the real layout then
  moves or replaces. The column is certain: the same width (`sidebarLastWidthAtom`,
  clamped like `LoroSidebar`), the same colour, and the same border.
- **A head script decides theme and column.** It runs before the shell is parsed.
  It reads the theme `ThemeProvider` will apply (stored choice, else the OS
  preference) and sets `dark` or `light` on `<html>`. It decides whether the
  workspace sidebar will show: not on non-workspace routes, on settings, or when the
  sidebar is collapsed; session windows default to collapsed and auxiliary windows
  read their own storage. It records that on `<html>` as `data-lody-boot-sidebar`,
  with the width in a CSS variable. React's copies read the same attributes, so the
  decision is made once. The script only reads storage. On any failure it falls
  back to the light canvas with the mark alone.
- **Safe area like the layout root.** The shell pads its top and sides by
  `env(safe-area-inset-*)`, as `LAYOUT_SAFE_AREA_INSET_CLASS` does for the desktop
  layout root, so in the iPad native shell the sidebar column starts below the
  status bar. Below the mobile breakpoint it does not pad, because the mobile layout
  insets its own surfaces.
- **Continuity over motion.** The mark fades in after 120 ms and starts a slow
  breathing pulse at 1.2 s, so a fast start never sees motion. Delays are measured
  from navigation start (`--lody-boot-elapsed`), so React's copy continues the static
  copy's phase instead of restarting. Gate copy fades in under the mark at 0.9 s.
  Reduced motion turns both off.
- **Boot gates use the shell.** `LoadingPlaceholder` gains `variant="boot"`. The route
  gates in `routes/index.tsx`, `routes/$workspaceName.tsx` and `_auth.tsx`
  (starting the local workspace, signing in, loading workspaces) use it.
  `viewport` stays for callers inside panes (session detail, login). The local
  layout's `RouteSuspense` fallback is now the shell on every route.
  `CriticalWorkspaceShell` is removed. It used to fall back to `null` off the chat
  route, which blanked the window again.
- **Stylesheets after the shell.** In builds the plugin moves `<head>` stylesheet
  links to the end of `<body>`. There they block only content after them, so the
  shell paints at once. Module scripts still wait for script-blocking stylesheets,
  so React never renders unstyled.
- **Plain CSS on purpose.** The shell styles a document no bundle has touched, so it
  cannot use StyleX, theme variables (written by JS) or product fonts. The mark is
  the brand jellyfish (`assets/icon-transparent.png`, the owner's pick over the
  monochrome `lody.svg` silhouette), cropped and re-encoded as a 96px WebP and
  inlined as a data URL (about 6KB), so it needs no request. The colours
  are literal copies of Lody Light and Vesper's `--background`,
  `--sidebar-background`, `--sidebar-border` and `--muted-foreground`.
  `tests/boot-shell.test.tsx` resolves the bundled themes and fails on drift.
- **CSP by hash.** The desktop renderer forbids inline scripts. `index.html` and
  `devbar.html` allow the boot script by its SHA-256, and `renderer-csp.test.mjs`
  fails when the script changes without the hash. A host with a header CSP adds
  `bootShellScriptCspSource()`.

## Alternatives considered

- **A skeleton of the real layout.** Rejected by the owner's brief ("最明显的简易框架即可")
  and on the merits: placeholder rows never line up with real rows, so they add a
  frame that moves.
- **An external boot script.** It avoids the CSP hash but adds a render-blocking
  request before the first paint, which is exactly what a slow network cannot afford.
- **CSS-only theme via `prefers-color-scheme`.** No script, but a user whose stored
  theme differs from the OS gets the wrong canvas for the whole boot, and CSS cannot
  read the sidebar width.
- **Keeping the static shell as an overlay until the layout signals.** This would
  hide React's first frames too, but it needs a removal protocol that every gate,
  the boot-failure path and warm windows must honour. Making React's gates draw the
  same frame gets the same result without that protocol.

## Verification

- `tests/boot-shell.test.tsx` covers:
  - the script's theme resolution;
  - the sidebar decision (workspace, hash history, stored and clamped widths,
    collapsed, settings, login, onboarding, the root with and without a last
    route, session and auxiliary windows) and the storage-failure fallback;
  - that the injected script matches the CSP hash;
  - marker handling and the stylesheet move;
  - that React and static markup match;
  - that the colours match the bundled themes.
- `apps/electron/src/renderer/renderer-csp.test.mjs` checks both renderer entries
  for the markers and the current hash.
- The iPad case was emulated on the desktop build at 1180×820 with CDP
  `Emulation.setSafeAreaInsetsOverride` (top 24/bottom 20, and an exaggerated
  left/right 44). Before the fix, the shell's sidebar column started 24px higher
  than the real one; after it, the shell and the layout line up on every edge.
  A real device or simulator run of the native shell was not possible here.
- A desktop reload was recorded under Xvfb with every script, stylesheet and wasm
  request delayed by 1.5 s through a main-process `file:` handler, before and after.

## Limits

- The web host lives outside this repository. It needs to add the plugin, the markers
  and, if its CSP is a header, the hash. The web-side paint timing has not been
  measured here.
- The inlined mark adds about 8KB of base64 to each entry HTML, and a web host's
  CSP must allow `data:` images, as the desktop renderer's already does.
- The Electron `BrowserWindow` background still follows the OS theme, so a user whose
  stored theme differs from the OS can see one native frame in the wrong colour before
  the document paints.
