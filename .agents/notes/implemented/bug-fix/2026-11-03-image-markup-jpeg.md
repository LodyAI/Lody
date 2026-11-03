# Encode marked-up image attachments as JPEG

Status: implemented
Translation: current

[中文](2026-11-03-image-markup-jpeg.zh.md)

## Abstract

An image below the attachment size limit could become an oversized PNG after
markup, preventing the composer from accepting it. The image markup editor now
exports a JPEG and reduces encoding quality if necessary to stay within the
existing 5 MiB image limit. Transparent pixels are composited on white and JPEG
compression is lossy. Image attachments sent without accepting markup keep their
original bytes and format; document selection captures continue to use PNG.

## Decision and limits

The [markup workspace](../feature/2026-10-31-image-markup-workspace.md) continues
to render the image and marks into a bounded canvas, then replaces the draft only
when the composer accepts the result. Its shared selection encoder chooses JPEG
only for the markup editor and checks the encoded bytes against the shared image
limit. Encoding retries at lower qualities without changing the editor canvas;
failure keeps the editor and original attachment available. Cancel still retains
the original. Existing image markup already used a single decoded frame for GIFs.

PNG would preserve transparency and avoid lossy re-encoding, but its output can
exceed the limit even when the source file fits. JPEG trades those properties for
a smaller marked-up image. This change does not alter ordinary attachment intake,
upload or Agent transport.

A synthetic 2048 × 1792 PNG measured 3.76 MiB before markup and 5.16 MiB as a
quality-0.92 JPEG in WebKit. The lower-quality retry produced a 4.51 MiB JPEG.
The attachment limit therefore has to be checked after encoding, even when the
original file and canvas dimensions are already within their bounds.

## Verification

The focused browser coverage exercises image markup, transparent pixels, the
size limit, encoder failure and cancellation, while the existing document-capture
coverage checks the PNG path. Live provider and physical-device acceptance are
not established by these tests.
