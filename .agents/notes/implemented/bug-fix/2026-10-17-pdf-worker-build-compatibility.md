# PDF Worker build compatibility

Status: implemented
Translation: current

[中文](2026-10-17-pdf-worker-build-compatibility.zh.md)

## Abstract

PDF.js's legacy Worker still uses `Promise.withResolvers`, which is absent from
Safari 16.4. Importing it as a raw URL asset bypassed host Worker transforms, so
main-thread compatibility code could not protect PDF loading. The viewer now
uses a project-owned Worker entry built through Vite, while preserving the export
PDF.js needs when dedicated Workers are unavailable. A built-asset test opens and
reopens a PDF in a separate realm without the native API and also exercises the
main-thread fallback; this does not replace validation on an older physical device.
Closing a preview also clears its document and aborts its lifetime, releasing its
document/editor listeners. Global text-selection listeners remain active until
the final text layer closes, so closing one PDF does not break another open PDF.

## Decision and evidence

This extends the [PDF preview decision](../feature/2026-09-29-session-pdf-preview.md).
Keep the legacy viewer/parser/Worker package entries aligned. The legacy bundle
provides several newer APIs itself, including `Promise.try` and `URL.parse`, but
does not supply `Promise.withResolvers` or `AbortSignal.any`.

`session-file-pdf.worker.js` re-exports `WorkerMessageHandler`; the viewer imports
its URL using `?worker&url`. This sends the dependency through each host's Worker
plugin pipeline. Hosts needing runtime compatibility must install their prelude
there, before dependency evaluation. A normal `?url` import copies the dependency
as an asset and cannot provide that guarantee.

PDF.js continues to create, own and terminate its Worker through the existing
document loading task. Do not introduce a shared `workerPort`: that would change
teardown and reuse behavior. Its fallback dynamically imports the Worker URL and
reads `WorkerMessageHandler` from the module namespace, so the export is required
even though a dedicated Worker starts through side effects.

Vite 7 overwrites `worker.rollupOptions.preserveEntrySignatures` with `false`.
`preservePdfWorkerExports()` applies `strict` in the later Rollup options hook,
only for the PDF entry. Public Electron and Storybook install it in their Worker
plugin pipelines; other compositions consuming this viewer need the same helper.

Pass the component's lifetime signal to `PDFViewer`. On disposal, call
`setDocument(null)` before aborting that signal, then destroy the loading task.
`cleanup()` only resets unfinished page rendering; it does not abort the document
event owner or destroy the annotation-editor manager. Even a normal read-only PDF
creates that manager and its keyboard/text-layer listeners. Clearing the document
releases these owners, while the lifetime signal releases scrolling and the resize
observer. Clear the link service's document
as part of the same teardown. This is required for hosts whose compatibility
implementation retains PDF composite signals until their owners abort.
PDF.js 6.3.289's shipped types omit both the constructor's `abortSignal` and the
nullable `PDFViewer.setDocument` argument. Keep their type extensions local to
this component, matching the verified runtime behavior.

PDF.js 6.3.289 combines its static text-selection controller with the first
viewer's lifetime signal. Closing that viewer removes global listeners while
other text layers remain registered, and their non-null static controller prevents
re-registration. The `pdfjs-dist` pnpm patch makes global listeners depend only on
`TextLayerBuilder.#selectionChangeAC`; removing the last text layer already aborts
and resets it. Per-viewer and per-layer signals retain their existing ownership.
Apply the same small patch to legacy and modern viewer entries. Do not remove the
viewer signal or replace `setDocument(null)` with `cleanup()` to work around this
shared-state bug: that would leave other listeners alive.

PR: [#1643](https://github.com/LodyAI/Lody/pull/1643).

## Verification and limits

- A production-style Vite Worker build initially lost the export; the helper
  preserves it, including with the existing top-level-await transform.
- The built Worker automatically initializes its message port in a separate realm
  without `Promise.withResolvers`, then opens and reads a one-page synthetic PDF
  twice with document teardown between opens.
- PDF.js's real no-Worker path imports the emitted asset and reads the PDF too.
- A current-WebKit test removes the newer native APIs, renders the real preview's
  text layer, and closes/reopens it twice. It observes PDF.js's actual composite
  signals and keyboard, selection and pointer listener registrations; all signals
  abort on close and their native DOM listeners stop responding. A build-only
  regression probe with the old `cleanup()` leaves document signals active.
- A deterministic two-preview sequence renders A, renders B, selects text in B,
  closes A, and selects text in B again. It then closes B and reopens C, checking
  both selection behavior and final listener disposal. Before the dependency
  patch, B stops entering its `selecting` state after A closes.
- The existing PDF range/parser suite passes all three tests.
- These are build and runtime-behavior checks, not physical iOS device acceptance.
