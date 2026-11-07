# macOS Emacs caret navigation across committed mentions

Status: implemented
Type: bug-fix
Translation: current

[中文](2026-10-27-mention-emacs-caret-navigation.zh.md)

## Abstract

macOS's default Emacs text-navigation keys could leave the caret stuck at a committed mention because the browser's character move entered an atomic range and selection normalization snapped it back. The mention input now routes Control+B/F through its existing range-aware horizontal movement at a mention edge. Component coverage verifies the behavior, while native Electron keyboard dispatch remains to be checked manually.

## Decision

Treat macOS's default Emacs-style Control+B and Control+F text-navigation keys as character-left and character-right movement at a committed mention boundary. Reuse the existing atomic range navigation for Left and Right Arrow. Preserve the browser's default handling away from adjacent mentions and when a selection or Shift modifier is present. Other platforms keep their existing Control-key behavior.

The key mapping is isolated in `getHorizontalCaretMove`. Other default macOS Emacs movement keys have line-based destinations (Control+A/E/P/N), and editing keys change text; this character-boundary fix leaves those commands to the browser rather than treating every Control shortcut as an arrow.

## Evidence

- The reporter observed Control+B leaving the caret flashing at the end of a file mention and confirmed that plain Left and Right Arrow already work. The symmetric Control+F failure is inferred from the same source path and covered by a component test; it was not separately observed in the desktop app.
- Previously, `mention-input.tsx` intercepted only arrow keydowns. A native one-character Control+B move would enter the mention, and `constrainCaretToMentionBoundary` would snap the caret back to its original edge. This source-level reproduction explains the observed stall without changing the atomic editing rule.
- The component test commits a synthetic file mention and checks both Control shortcuts, the separating space, ordinary arrows, non-macOS behavior, and selected text. jsdom does not implement native macOS Emacs key navigation, so the test verifies the component's keydown response, not the operating system's keyboard dispatch.

## Scope and verification

The change is confined to the shared mention input, its component suite, and the mention implementation guide. No mention storage, dispatch, or hydration contract changes. A native desktop reproduction after the fix remains useful because the automated component suite cannot verify Electron's macOS key event mapping.
