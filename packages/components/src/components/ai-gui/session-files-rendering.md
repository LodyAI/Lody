# Session files and image preview

File attachments use `file` blocks; the product contract is in
`specs/session-files.md`.

- `session-file-card.tsx` — `SessionFileCardLayout` is shared by pending and delivered
  cards. The delivered card is evidence, so it rests quietly under the answer, but it is the thing
  the agent made and reads as a small sheet of paper laid on a tray. Two surfaces only: the tray is
  `secondaryBackground` with no outline or shadow; the sheet is `raisedBackground` with
  `shadow.card`, the only shadow, so no edge is drawn twice. The sheet's top-right corner is not
  painted (the tray shows through, whatever tint it has) and the fold lies in the remaining half.
  The sheet (`session-file-sheet.tsx`) is narrow and portrait and prints no glyph (one was tried and
  made it read as a badge) and no extension, which the line beneath the name spells. It carries
  faint tonal marks of ink instead, drawn per file kind so a column of files reads as different
  pages: ruled lines (text, document, binary), indented lines (code), brace-like lines (data), a
  header-and-cells grid (spreadsheet), a zipper (archive), a waveform (audio), a picture over two
  captions (image) and the same with a play mark (video). The marks are a step of `label` over the
  paper, never a hue, and the first line of every page stops short of the fold.
  Beside it, the name is the only line at full ink; under it, `secondaryLabel` spells the type and
  size ("PDF · 2.4 MB", via `formatSessionFileMeta`, which the pending row shares so the handoff
  to history does not change the text; no short extension means the size alone) or the status. The
  action chip trails and rests at `secondaryLabel` (a dimmer rest read as disabled), sinking into a
  well on hover of the main button. The sheet scales with Appearance (`captionSize` units). On a card that opens something
  the sheet lifts and tilts a hair and takes `shadow.raised`; pending and expired dim it, and a
  failed card tints the tray toward `destructive` and its reason takes label ink. Under
  `prefers-reduced-motion` the lift is instant, not animated. There is no colour per file kind,
  because colour is reserved for outcomes. Transport and `getServerNow()` expiry determine pending/expired/previewable/
  downloadable state. `SessionFileCardList` aggregates adjacent blocks. Story:
  `SessionFileCard.stories.tsx`, test: `tests/session-file-card.test.tsx`.
- Static shares pass `retention='publication'`: the copied object has no dependency
  on the source upload's expiry. Its manifest-gated reader decides availability.
- One card, one primary action — EXCEPT an HTML attachment, which also gets a separate
  download button for the source bytes. Its click opens the RENDERED page (browser
  surface or live file preview), a surface with no control of its own for the file that
  was uploaded; every other previewable file opens the preview dialog, which already
  downloads from inside, so it must not grow a duplicate control. That button carries the
  in-flight spinner, and the primary affordance keeps reading as preview.
- `session-file-preview-dialog.tsx` — `SessionFilePreviewPanel` (status-driven;
  markdown reuses `MarkdownRenderer`, raw toggle, copy=raw, truncation) and dialog wrapper.
  Complete HTML fallback attachments open in the shared `ReadOnlyHtmlPreview`, with
  an eye toggle beside Copy in the existing header. Source mode and Copy retain
  the original text; loading, errors and truncated HTML never mount the iframe.
  On mobile, all these file types use a bottom Drawer/Sheet taking approximately
  94dvh (respecting top and bottom safe areas), with a fixed header and scrolling
  body; HTML fills the available body. Desktop retains the centered Dialog and
  55vh content cap. Preview uses the script-free sandbox, with no
  live-file provenance or Browser connection required.
  Story: `SessionFilePreviewPanel.stories.tsx`.
- `view.tsx` `SessionFileGroup` owns atoms/download/preview-fetch and resolves the pending
  machine name. Both render switches and `UserChatBubble` route `file` blocks through it.
  Upload/download/preview helpers: `@/lib/session-file-{upload,download,presentation}.ts`.
- Agent-uploaded blocks may carry a workspace-relative `sourcePath` proven by the CLI's
  containment check. It is provenance for reopening the live file, never a download path.
  HTML clicks use it only for same-machine Sessions and enter the existing rendered file
  preview. Remote HTML clicks reuse an active Browser connection; an available reported
  candidate requires an explicit confirmation before creating its tunnel. Missing provenance
  or preview state falls back to the ordinary attachment preview instead of guessing.
- `@/lib/session-file-download.ts` `downloadSessionFile` branches by platform
  (`isNativeAppShell()`): web/electron uses blob + `<a download>`; native mobile routes to
  `@/lib/session-file-native-save.ts` (Capacitor Filesystem chunked base64 write to the
  cache dir → Share sheet → best-effort cleanup; never buffers the whole file). Base64
  streaming math is in `@/lib/base64-chunk.ts` (tested by `tests/base64-chunk.test.ts`).
  Capacitor plugins stay dynamically imported so web/electron bundles remain clean.
- A group of image attachments is ONE wrapping row (`IMAGE_ATTACHMENT_ROW_CLASS` in
  `view.tsx`), used by `ImageGroupBubble` and the user row's grouped `image` items.
  Never give it a fixed column count or a max width: the thumbnail is a fixed square,
  so a `grid-cols-2` turned a thirteen-image turn into a two-wide tower that scrolled
  for screens. Tiles keep `shrink-0` (flex shrinks before it wraps) and hug the
  speaker's side. Decision:
  [image attachment row](../../../../../.agents/notes/implemented/bug-fix/2026-09-15-image-attachment-row-wraps.md).

## Codex file citations

Markdown prose recognizes `:codex-file-citation{path="..."}` as a local file card,
including paths wrapped in whitespace/newlines and optional `purpose` / `artifact_kind`
attributes. It reuses `SessionFileCardLayout` and the Markdown file-link action/menu
boundary; it does not fabricate an uploaded attachment, size, expiry, or download URL.
Filename punctuation is URL-encoded for transport through the existing href resolver.
Windows drive prefixes stay unescaped and backslash separators normalize to slashes,
so absolute artifact targets retain their drive. The citation walk leaves non-container
Markdown nodes untouched, including inline/display math.
In conversations, relative citations stay path text until the owning index confirms
the file; absolute citations render immediately. Clicking a legal target opens it
directly; without an opener or with an invalid target it copies the original path
and reports success. Copy menus never resolve a path before copying. Invalid/incomplete citations and
code examples do not become cards. The inline card uses a span frame to keep paragraph
markup valid. Coverage lives in the Markdown file-link and streaming renderer suites;
`MarkdownCodexFileCitations` provides the visual states.

## Upload-to-history continuity

Pending file attachments reuse `SessionFileCardLayout` and `SessionFileCardList`,
including the delivered row's insets. Progress overlays the bottom edge; it adds
no height. Ready files show their size in the same subtitle slot. Failure reasons
still belong to their affected card.

`session-attachment-preparation.ts` seeds `session-image-cache.ts` with each
successful image upload before releasing its source. The pending image and
`view.tsx`'s delivered image read that workspace/session/image-scoped cache
synchronously, so history publication needs no fresh thumbnail request or
loading frame. Native iOS seeds a data URL before readiness to preserve its
long-press sharing behavior. Browsers supporting `decode()` warm that URL before
it becomes ready, avoiding a local decode flash. The existing 200 MiB memory bound and object URL
cleanup remain; eviction/restart uses normal loading. Cancelled or cache-cleared
native conversions cannot publish late previews. Preview caching failures do
not fail an otherwise successful upload.

Behavioral coverage: `tests/session-image-cache.test.ts`,
`tests/session-attachment-preparation.test.ts`, and
`tests/session-pending-message-row.test.tsx`. `SessionPendingMessages.UploadToHistory`
and its narrow counterpart exercise the real pending and delivered rows with
synthetic bytes. This replaces the earlier reserved file-progress row and closes
the extra thumbnail-load gap documented in the
[deferred-attachment note](../../../../../.agents/notes/implemented/architecture/2026-09-14-deferred-attachment-send.md#sending-in-place-2026-09-29).

## Image-preview overlay (zoom / pan)

- **There is exactly ONE zoomable image surface in the app:**
  `../shared/zoomable-image-viewer.tsx` (`ZoomableImageViewer`, wrapping
  `react-photo-view` `PhotoSlider`). It owns pinch-to-zoom, double-tap/wheel zoom,
  drag-to-pan, and the top-right close button. Tapping the photo stays inside the
  pan/zoom surface, and vertical pulls do not dismiss it; close through the
  toolbar or backdrop. Both callers mount it:
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
  the shared viewer marks its modal and photo portal roots `data-vaul-no-drag`
  so Vaul does not take over pan/pinch gestures.
- The shared viewer owns modal focus isolation and named UI buttons: initial
  focus is Close, Tab stays inside, background content is inert, and closing
  returns focus to the connected opener. The photo portal lives inside this
  boundary, including while its source is loading.
- `react-photo-view@1.2.7` is patched in root `patches/` to hard-clamp the MINIMUM
  pinch scale at `1` (no shrink-below-fit rubber band; max stays 6×). Do not replace
  this with an outer `overlayRender`/React state clamp; that fights PhotoView's touch
  state.
- One viewer, two presentations (`zoomable-image-viewer.css`): touch keeps the
  full-bleed overlay; desktop (`useIsMobile() === false`) gets a lightbox — the
  photo inset by a `transform: scale()`, a translucent + blurred mask
  (`maskOpacity`), a gradient top bar padded clear of the macOS traffic lights /
  Windows caption buttons with its controls centered on their line (y=23 / the
  36px caption strip), and no `1 / 1` counter for a single image. Never inset
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
