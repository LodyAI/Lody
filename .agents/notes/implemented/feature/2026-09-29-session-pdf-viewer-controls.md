# Session PDF viewer controls

Status: implemented
Translation: current

[中文](2026-09-29-session-pdf-viewer-controls.zh.md)

## Abstract

The session PDF preview now provides thumbnail navigation, rotation, fit and
percentage zoom, and expandable search around the existing PDF.js document view.
A live Storybook check also found that PDF.js rejected the viewer's relatively
positioned scroll container; positioning it absolutely makes the document render.
The PDF remains read-only and keeps its existing range transport and file actions.
The Storybook acceptance path is verified with Playwright; a real Electron resource
scheme run is still outside this worktree's verification.

## Decision

The document preview owns reading controls. The session side panel continues to
own Open, Reveal, Download, and Share according to its existing platform and file
capabilities. An upload control would imply replacing or writing the session file,
which this read-only viewer does not do. This extends the
[local file action Spec](../../../../specs/local-file-link-actions.md) without
changing the file action model.

Use PDF.js's paged viewer for the document and render thumbnail canvases only for
the visible sidebar rows. Page changes from the document or thumbnails share the
viewer's current page. Rotation restores that page after PDF.js refreshes its
layout. Fit-width remains the initial zoom; changing the sidebar width recomputes
fit modes. Search opens on demand, reports match count, and clears its highlight
when closed. Product layout and the Storybook frame use StyleX.

The prior [PDF preview decision](2026-09-29-session-pdf-preview.md) owns the range
transport, 8-megapixel page budget, and parser compatibility. Its Storybook build
verification did not exercise mounting the PDF viewer; the live story failed with
PDF.js's absolute-position requirement. The Playwright acceptance capture records
that baseline failure and the working viewer with the same synthetic four-page PDF.

## Verification

- `@lody/components` typecheck passed.
- Playwright Storybook acceptance passed for thumbnail jump, page-preserving
  rotation, fit-page zoom, search result navigation, and a narrow panel.
- The real Electron `lody-resource://` renderer path remains unverified here.
