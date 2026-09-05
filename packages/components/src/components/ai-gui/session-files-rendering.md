# Session files and image preview

File attachments use `file` blocks; the product contract is in
`specs/session-files.md`.

- `session-file-card.tsx` — pure card (icon by extension, name, size; pending/expired/
  previewable/downloadable derived from transport + `getServerNow()` expiry) and
  `SessionFileCardList` (adjacent-block aggregation). Story: `SessionFileCard.stories.tsx`.
- `session-file-preview-dialog.tsx` — `SessionFilePreviewPanel` (status-driven;
  markdown reuses `MarkdownRenderer`, raw toggle, copy=raw, truncation) and dialog wrapper.
  Story: `SessionFilePreviewPanel.stories.tsx`.
- `view.tsx` `SessionFileGroup` owns atoms/download/preview-fetch and resolves the pending
  machine name. Both render switches and `UserChatBubble` route `file` blocks through it.
  Upload/download/preview helpers: `@/lib/session-file-{upload,download,presentation}.ts`.
- Agent-uploaded blocks may carry a workspace-relative `sourcePath` proven by the CLI's
  containment check. It is provenance for reopening the live file, never a download path.
  HTML clicks open the in-app preview dialog (retaining Download and Copy); when live provenance
  is present, the dialog additionally offers an action to open the rendered file preview (local)
  or Browser connection (remote). Missing provenance or preview state falls back to the ordinary
  attachment preview without the live action.
- `@/lib/session-file-download.ts` `downloadSessionFile` branches by platform
  (`isNativeAppShell()`): web/electron uses blob + `<a download>`; native mobile routes to
  `@/lib/session-file-native-save.ts` (Capacitor Filesystem chunked base64 write to the
  cache dir → Share sheet → best-effort cleanup; never buffers the whole file). Base64
  streaming math is in `@/lib/base64-chunk.ts` (tested by `tests/base64-chunk.test.ts`).
  Capacitor plugins stay dynamically imported so web/electron bundles remain clean.

## Image-preview overlay (zoom / pan)

- **There is exactly ONE zoomable image surface in the app:**
  `../shared/zoomable-image-viewer.tsx` (`ZoomableImageViewer`, wrapping
  `react-photo-view` `PhotoSlider`). It owns pinch-to-zoom, double-tap/wheel zoom,
  drag-to-pan, and the top-right close button. Both callers mount it:
  `view.tsx` `ImagePreviewDialog` (chat image blocks, gallery of the turn's images)
  and `../sessions/session-file-image-preview.tsx` (Code Collab file preview, one
  image). A new image surface must reuse it rather than hand-roll gestures —
  the two paths are required to feel identical.
- The file preview stays a fitted `<img>` inline and opens the viewer on tap.
  `react-photo-view` has no inline mode, and a hand-rolled inline zoom would be a
  second gesture implementation fighting Vaul drawer drag + the file browser's
  `MobileEdgeBackSwipeZone`.
- Inside mobile Vaul drawers, do not default the portal to `document.body`:
  Radix/Vaul treats body portals as outside the drawer, so touch/scroll can be
  blocked or fall through. Pass an in-drawer element as `portalAnchorRef`;
  `resolveImagePreviewPortalContainer` walks up to the real `[data-vaul-drawer]`
  (not the `data-vaul-no-drag` body wrapper, which is `display: contents`) and
  `useImagePreviewPortalNoDrag` marks the mounted portal root `data-vaul-no-drag`
  so Vaul does not take over pan/pinch gestures.
- `react-photo-view@1.2.7` is patched in root `patches/` to hard-clamp the MINIMUM
  pinch scale at `1` (no shrink-below-fit rubber band; max stays 6×). Do not replace
  this with an outer `overlayRender`/React state clamp; that fights PhotoView's touch
  state.
- One viewer, two presentations (`zoomable-image-viewer.css`): touch keeps the
  full-bleed overlay; desktop (`useIsMobile() === false`) gets a lightbox — the
  photo inset by a `transform: scale()`, a translucent + blurred mask
  (`maskOpacity`), a gradient top bar padded clear of the macOS traffic lights /
  Windows caption buttons, and no `1 / 1` counter for a single image. Never inset
  the photo by capping `width`/`height` (PhotoView centers the box IT sized, so a
  capped box lands off center) or by padding (it erases an image smaller than the
  inset).
- Right-click inside the viewer opens a NATIVE Copy / Save menu, Electron only
  (`../../lib/image-preview-export.ts` + `apps/electron/.../image-export-service.ts`).
  The image is a `blob:` URL, so main cannot download it: main pops the menu and
  the renderer sends bytes for the chosen action — PNG re-encoded through a canvas
  for the clipboard, original encoding for the save. Callers pass `fileName` on
  each `ZoomableImageViewerItem` for the save-dialog default. With no preload
  bridge the handler must not `preventDefault()`: web keeps the browser's menu.
- Still plain non-zoomable `<img>`, by scope not by accident: tool-call `image`
  content blocks in `view.tsx` and markdown images in `markdown-renderer.tsx`.
