# PDF side-panel height and fit scaling

Status: implemented
Translation: current

[中文](2026-10-24-pdf-side-panel-layout.zh.md)

## Abstract

A PDF opened in the session side panel had a zero-height scrollport and displayed
no pages until thumbnails supplied an in-flow height. PDFs now use the existing
definite-height branch for viewers that own scrolling. A container resize observer
also reapplies preset fit modes while preserving explicit percentage zoom.

## Decision and evidence

This extends the [PDF preview decision](../feature/2026-09-29-session-pdf-preview.md)
and addresses [#1731](https://github.com/LodyAI/Lody/issues/1731). The Base UI
ScrollArea migration does not give its content wrapper a definite height. Keep
PDF scrolling inside PDF.js, as with Office previews, rather than changing the
shared ScrollArea's intrinsic sizing for other content.

PDF.js caches preset scales. Observe its scrollport, defer fitting until both
dimensions are nonzero, and reapply the current fit mode after resizing. Explicit
percentage zoom calls `update()` without changing scale. Disconnect the observer
with the viewer; retain the bundled Worker and existing abort/document cleanup.

## Verification

On upstream `725f843fb`, isolated Linux Electron/Xvfb measured a 598×0 px PDF
scrollport with no page canvas; opening thumbnails produced a 426×760 px scrollport
and rendered the first page. The real layout stories for a newly opened and a
retained collapsed file panel both failed the height assertion (`> 400`, actual 0).
The desktop fixture uses a synthetic PDF, offline ACP provider and isolated data,
including a synthetic legacy machine identity needed by the current local-file IPC.
With the fix, the same desktop scrollport is 598×809 px with a 558 px first page;
dragging it to 468×809 px refits the page to 428 px. Both layout cases and all
14 PDF acceptance cases pass, along with 75 related unit tests.
macOS and Windows desktop behavior is not covered by this run.
