# Shared surface components

Parent `AGENTS.md` files also apply. `CLAUDE.md` is a symlink to this file; edit
`AGENTS.md` only.

- `AgentActivityIndicator` animations stay CSS-only and compositor-friendly
  (`transform`/`opacity`). Do not restore canvas frame loops, React animation state, or
  timers; keep the Storybook Playwright render budgets passing.
- `ZoomableImageViewer` is the one image viewer, and it presents per
  surface: full-bleed on touch, a lightbox on desktop (inset photo, translucent mask, a
  top bar that clears the native window controls). Inset the photo with a transform
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
