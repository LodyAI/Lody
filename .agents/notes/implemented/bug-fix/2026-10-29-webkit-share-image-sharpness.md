# WebKit share-image sharpness

Status: implemented
Translation: current

[中文](2026-10-29-webkit-share-image-sharpness.zh.md)

## Abstract

SnapDOM 2.24.15 rasterizes WebKit share images with shadows at natural size before enlarging them, making text blurry. The shared exporter renders a shadow-processed SVG at the target resolution, but keeps its viewBox at output size and scales the HTML with `zoom`: WebKit otherwise paints positioned HTML inside an enlarged `foreignObject` at the wrong size and location. Browser tests cover geometry, shadow and text detail; saving through the iOS photo library has not been verified.

## Decision and verification

The [native share handoff](2026-10-07-native-share-image-save.md) sends PNG bytes to the system sheet and does not control destination processing. The [fixed card](../feature/2026-09-14-chat-share-card-fixed-template.md) has a shadow on its default ground. SnapDOM's WebKit shadow workaround rasterizes at natural size before scaling, so increasing the final canvas scale alone cannot recover text detail.

The exporter retains SnapDOM's shadow-processed SVG, makes the SVG viewBox match the output pixel dimensions, and applies the output scale to its `foreignObject` bounds and HTML wrapper. WebKit otherwise drops the SVG scale for positioned HTML ([WebKit bug 23113](https://bugs.webkit.org/show_bug.cgi?id=23113)), leaving the card at roughly half size on the background. The shared helper also serves usage cards. Other engines keep the PNG path; long images retain the 16,384-pixel side and area bounds, and an SVG fallback to PNG is rejected.

The [WebKit browser regression](../../../../packages/components/tests/e2e/interface-typography.spec.ts) checks exported PNG geometry with and without preview scaling, shadow pixels and text sharpness. It uses a synthetic card and does not exercise the native share sheet or a physical iPhone.
