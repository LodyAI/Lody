# Sidebar footer action order

Status: implemented
Translation: current

[中文](2026-09-26-sidebar-footer.zh.md)

PR: [#1001](https://github.com/LodyAI/Lody/pull/1001)

## Abstract

The footer grouped Archive and Help under More after Settings, preventing direct
access to the requested three actions. It now shows Help (`?`), Archive, Settings.
Archive keeps its existing return behavior, and Help remains available inside
Archive. This trades one additional visible icon for direct access.

## Decision and evidence

This partially replaces the footer decision in the
[reading-contrast note](2026-09-24-reading-contrast.md); its other decisions remain.
The [Spec](../../../../specs/sidebar-footer.md) describes the new order.
`LoroSidebar` owns rendering and existing callbacks; the E2E archive helper now
uses the standalone button. Help places GitHub directly after Docs. The app sidebar
opens the repository and feedback Issues URLs through `openExternalUrl`, sharing
the desktop/browser link handling already used by Docs.
The existing sidebar suite checks order, destinations,
the Help menu, and the Archive exit; all 15 tests pass. Formatting, scoped static
analysis, translation-key validation, and documentation checks pass. Full-check
results are recorded in the PR; no interactive desktop inspection has been performed.
