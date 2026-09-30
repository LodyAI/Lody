# Scroll sidebar section labels with their rows

Status: implemented
Translation: current

[中文](2026-09-26-sidebar-section-scrolling.zh.md)

## Abstract

Sticky sidebar labels could overlap project rows while scrolling. Section labels
now stay in normal document flow and scroll out with their rows, as requested.
This removes the need for a header overlay, at the cost of losing the persistent
machine label in long sections. Browser validation is pending in this checkout.

## Decision

This supersedes the sticky behavior retained by the
[header background fix](2026-09-26-sticky-sidebar-group-header-background.md)
and introduced by the
[group label design](../feature/2026-09-25-deep-sea-palette-and-sidebar-groups.md).
The background correction remains useful historical evidence, but making an
overlay opaque does not meet the requested scrolling behavior.

Remove the shared sticky wrapper constant and its uses in machine and Chats
headers. Keep their controls and dimensions, and adapt the existing scrolling
Storybook fixture to the new expectation. Current intent lives in the
[Spec](../../../../specs/sidebar-section-scrolling.md).

## Verification limits

Reviewed both production header paths and the fixture. This checkout has no
installed dependencies, so component typechecking and browser execution remain
unverified. No new automated test is added for this CSS removal.
