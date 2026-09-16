# Main services

The Devbar Hub starts only behind `LODY_DEVBAR=true` and binds to loopback. Its
Terminals add-on intentionally grants local shell/subprocess access to the browser
and aggregate MCP surface; keep that capability inside the same explicit runtime
gate. Do not add filesystem management, code-server, non-loopback binding, or
remote access without a new capability/security decision in the owning
[Spec](../../../../../specs/desktop-devbar.md) and
[Agent Note](../../../../../.agents/notes/implemented/feature/2026-09-16-devbar-hub-ui.md).
