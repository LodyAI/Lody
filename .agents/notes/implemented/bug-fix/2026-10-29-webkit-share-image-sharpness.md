# WebKit share-image sharpness

Status: implemented
Translation: current

[中文](2026-10-29-webkit-share-image-sharpness.zh.md)

## Abstract

Share images with shadows were blurry on WebKit because SnapDOM 2.24.15 draws
its SVG at natural size into an intermediate canvas before enlarging it. The
shared export now asks SnapDOM for an SVG at the target pixel dimensions on
WebKit, then encodes that image as PNG. The layout, native share handoff and
2x target remain unchanged. A Playwright WebKit comparison of a synthetic card
shows sharper text at the same pixel dimensions; a real iOS photo-library save
has not been verified.

## Decision and verification

The [native share handoff](2026-10-07-native-share-image-save.md) sends the
captured PNG bytes to the system sheet. It does not control destination processing.
The [fixed card](../feature/2026-09-14-chat-share-card-fixed-template.md) includes
a shadow on its default ground. SnapDOM's WebKit shadow workaround uses a
natural-size canvas before scaling; increasing the final canvas scale alone
cannot recover its lost detail.

Render the SVG at the output dimensions before drawing it into the PNG canvas.
Keep SnapDOM's SVG path so its WebKit shadow compatibility handling remains in
place. Preserve its 16,384-pixel side and area bounds for long captures, and
report failure rather than accept its PNG fallback as a high-resolution SVG.
Other engines retain their existing PNG path. The shared helper also serves usage
cards, so both share surfaces use the fix on WebKit.

The [WebKit browser regression](../../../../packages/components/tests/e2e/interface-typography.spec.ts)
checks actual PNG dimensions, text detail against a downsampled copy, and the
effect of removing the shadow. The
standalone Playwright comparison used the locked SnapDOM version and the real
export helper with a synthetic card; it did not exercise the native share sheet,
the complete product component, or a physical iPhone.
