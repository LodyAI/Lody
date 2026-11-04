# Read the document width during iOS fold transitions

Status: implemented
Translation: current

[中文](2026-10-27-ios-fold-layout-width.zh.md)

## Abstract

During a Duo fold with the keyboard open, WebKit can report the previous
`innerWidth` after the document has resized, leaving the mobile layout mounted
on a wider display. Native iOS layout selection now reads and observes the
document viewport width, while other platforms retain their existing behavior.
The actual device transition still requires simulator and physical verification.

## Decision and evidence

The native simulator reported the new document width while `innerWidth` still
reflected the preceding display. A resize-only subscription could therefore
sample stale width. Observe the document and use its `clientWidth` in native
iOS, falling back to `innerWidth` before a document size is available. A
behavioral test models the delayed window width. This is separate from the
[native side rail](../feature/2026-10-27-native-side-rail.md).
