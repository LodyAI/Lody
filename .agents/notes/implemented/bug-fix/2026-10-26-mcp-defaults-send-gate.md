# New conversations no longer wait for remote MCP defaults

Status: implemented
Translation: current

[中文](2026-10-26-mcp-defaults-send-gate.zh.md)

## Abstract

New-conversation composers in cloud and dual composition blocked sending with
"Loading this project's default MCP servers…" until the workspace catalog room's
first remote sync landed. A slow, stuck or offline room therefore made every new
conversation unsendable. Default-derived selections now become sendable as soon as
the local catalog snapshot has been read, as local-only and E2EE composition already
did. The accepted trade-off: a client whose local replica has not yet received the
project's defaults may create a conversation from older or workspace-level defaults.

## Decision

`useSessionMcpSelection` reports `ready` once the local document is read; remote
catch-up only updates the still-unsent selection. A local read failure still blocks
with an error, because the spec forbids treating unreadable defaults as an empty
selection. Existing conversations and explicit selections were never gated.

This partially reverses the remote-sync gate recorded in
[project default MCP](../architecture/2026-10-09-project-default-mcp.md), which
prevented a fresh cloud client from persisting `[]`. Availability of the composer
was judged more important: the selection is visible and editable in the composer's
"+" menu before sending, and the earlier gate had no bound or recovery while offline.
An alternative of waiting with a timeout was rejected because it still delays every
send on a slow connection.

## Evidence

- [Selection hook](../../../../packages/components/src/hooks/use-session-mcp-selection.ts)
- [Selection tests](../../../../packages/components/tests/project-default-mcp.test.tsx)
  cover cloud/dual sends before catch-up and both content modes with an unsynced room.
- [Spec](../../../../specs/project-default-mcp.md)
