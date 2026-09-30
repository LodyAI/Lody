# Shared surface components

Parent `AGENTS.md` files also apply. `CLAUDE.md` is a symlink to this file; edit
`AGENTS.md` only.

- `MenuOptionSearchList` places search above the results; only options scroll.
  It stays content-sized within the host's cap. Never reserve
  unfiltered dimensions or keep an old popup origin to prevent query-driven layout
  changes; the desktop host must preserve its normal trigger-row anchor. Intent:
  [composer submenu placement](../../../../../specs/composer-run-config-submenu-placement.md).
- The live agent status (`AgentActivityRow` in `ai-gui/view.tsx`, and the collapsed
  group label it hands the status to) shimmers via `.agent-shimmer`, which animates only
  `transform`. Never switch it to a `background-position`/text-clip shimmer, canvas
  loop, React animation state or timer: those repaint every frame while an agent
  works. Keep the Storybook Playwright render budgets passing.
- `ZoomableImageViewer` is the one image viewer, and it presents per
  surface: full-bleed on touch, a lightbox on desktop (inset photo, translucent mask, a
  top bar that clears the native window controls and centers its controls on their
  line — the y=23 traffic-light row on macOS, the 36px caption strip on Windows).
  Inset the photo with a transform
  only — `react-photo-view` positions the box it sized itself, so a capped
  `width`/`height` decenters it and padding erases a small image. Its portal sits at
  `--z-image-viewer`, deliberately UNDER `--z-toast`, because the viewer's own copy/save
  confirmations are toasts.
- Image preview copy/save (`lib/image-preview-export.ts`) is Electron-only and splits by
  what each process can reach: main owns the native menu, clipboard, and save dialog;
  the renderer owns the `blob:` bytes and sends them only after the user picks an
  action. Copy re-encodes to PNG (the one format the system clipboard takes); save keeps
  the original encoding. Without the preload bridge the right-click must fall through to
  the browser's own menu.
