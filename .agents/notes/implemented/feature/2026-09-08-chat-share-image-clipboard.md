# Copy a selected chat image to the clipboard

Status: implemented
Translation: pending

## Abstract

The initial selected-chat image flow required saving a PNG before it could be
shared elsewhere. The preview now offers a local Copy image action alongside
export, reusing the same full-card PNG capture. Electron passes PNG bytes through
the existing native clipboard bridge, while capable browsers use the image
Clipboard API. A failed or unsupported copy keeps the preview available for retry
and does not publish conversation content.

## Decision

The copy action belongs to the image preview because it owns card appearance and
PNG capture. It is mutually exclusive with export so the rendered card is never
captured twice concurrently. Electron retains clipboard ownership in the main
process; the renderer produces bytes only after the user explicitly invokes copy.
Browser copying uses `ClipboardItem` and reports unsupported APIs as a recoverable
failure rather than silently falling back to a file download.

The existing background choices render as a visible swatch grid rather than a
text-only menu. It shows only the five implemented canvas values, keeping the
selection affordance aligned with the exported image instead of implying an
unavailable wallpaper library.

This extends the earlier [image export decision](2026-09-08-chat-share-image.md)
and updates the [draft specification](../../../../specs/chat-share-image.md).

## Evidence and limits

The export tests cover native clipboard success/failure and the browser clipboard
path with synthetic PNG blobs. They do not establish operating-system clipboard
compatibility or visual pixel fidelity.
