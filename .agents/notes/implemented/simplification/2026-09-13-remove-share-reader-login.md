# Remove the share reader login entry

Status: implemented
Translation: current

[中文](2026-09-13-remove-share-reader-login.zh.md)

## Abstract

The share reader offered anonymous visitors a top-right login link, including an
icon-only version on narrow screens. Remove that entry entirely so reading a
share carries no login prompt. Host-established viewer identity remains visible;
anonymous visitors have no identity placeholder.

## Decision and evidence

`session-share-identity.tsx` now returns null for signed-out visitors and no longer
accepts an app origin. The page still uses the origin for its existing brand link.
This removes the rendered control rather than hiding its text with responsive CSS.
The owning page test checks that neither login text nor a login link remains;
existing signed-in identity coverage is retained. Hosted deployment is outside
this change. Current intent is in the [sharing Spec](../../../../specs/session-sharing.md).
