# Sidebar search

Status: draft
Translation: pending

The sidebar offers a localized Search row immediately below New Chat. Clicking
Search opens the same command palette as Cmd K (Ctrl K on other platforms), with
the same search results and actions. It does not navigate away from the current
conversation or create a separate search interface.

## Implementation evidence

- [Sidebar](../packages/components/src/components/loro-sidebar.tsx)
- [Shared palette state](../packages/components/src/lib/commands/palette-state.ts)
