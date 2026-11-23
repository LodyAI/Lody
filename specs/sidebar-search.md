# Sidebar search

Status: draft
Translation: current

The sidebar offers a localized Search row immediately below New Chat. Clicking
Search opens the same command palette as Cmd K (Ctrl K on other platforms), with
the same search results and actions. It does not navigate away from the current
conversation or create a separate search interface.

Escape closes the command palette. While an input method editor is composing text,
Escape remains available to cancel that composition before closing the palette.

## Implementation evidence

- [Sidebar](../packages/components/src/components/loro-sidebar.tsx)
- [Shared palette state](../packages/components/src/lib/commands/palette-state.ts)
- [Palette keyboard handling](../packages/components/src/components/commands/command-palette-view.tsx)
