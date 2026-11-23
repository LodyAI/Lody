# Session PDF preview

Status: implemented
Translation: current

[中文](2026-09-29-session-pdf-preview.zh.md)

## Abstract

Large local PDFs reached the generic binary notice, while passing Electron's custom resource URL directly to PDF.js would disable its HTTP range reader. Session file previews now use PDF.js with a custom range transport that validates 64 KiB reads from the existing opaque, revision-checked local resource. The viewer adds page navigation, zoom, text search, and an 8-megapixel canvas limit, and returns failures to existing file actions. Remote provider limits remain unchanged; a real Electron renderer CORS run was not available in this worktree.

## Decision and evidence

Use PDF.js for the session viewer and `PDFDataRangeTransport` for `lody-resource://` files. PDF.js only treats HTTP(S) URLs as range-capable, so handing it the custom Electron URL could cause a full-file read. The range transport reads an initial bounded chunk, validates `Content-Range` and exact response lengths, then satisfies PDF.js's later range requests. Unmount aborts outstanding requests. The renderer receives no new full-file snapshot.

Use PDF.js's `legacy` build for the viewer, worker, range transport, and parser tests. The modern build calls `Promise.try`, which is absent from the repository's supported Node 22 CI runtime; the legacy build supplies that compatibility layer. Keeping every entry point on the same build also preserves the `PDFDataRangeTransport` class identity required by `getDocument`.

Electron identifies `.pdf` local resources as binary `application/pdf`; this avoids the text-page budget misclassifying an ASCII-only PDF and avoids reading a text-detection prefix. Its capability response exposes `Accept-Ranges` and `Content-Range` to cross-origin consumers. Existing file revision checks, renderer ownership, and resource revocation remain in force.

The PDF.js viewer owns page virtualization and caps each page canvas at 8 megapixels. It provides page selection, previous/next navigation, zoom, and text search. Read or parse failure uses the existing binary notice and file actions. Byte-backed providers continue to use their already-bounded preview bytes, and remote file limits are unchanged.

This adds `pdfjs-dist` to `@lody/components`. It does not extend remote file transfer, add a PDF endpoint, or relax local file authorization. The local resource unit test verifies PDF MIME and bounded range responses; cross-origin header exposure is asserted at the service boundary.

## Verification

- Component PDF range, parser, and preview-routing tests: 5 passed.
- The PDF range suite passes on Node 22.23.2, the CI runtime, with the legacy build.
- Electron local file resource tests: 10 passed.
- `@lody/components` typecheck and translation-key check passed.
- Storybook production build passed and bundled the PDF.js worker asset.
- The real Electron renderer scheme/CORS path remains unverified here.
