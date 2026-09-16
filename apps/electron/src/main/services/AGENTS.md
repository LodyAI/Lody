# Main services

The Devbar Hub is off by default and starts only after the primary window's hidden
Developer Mode control enables it; `LODY_DEVBAR=true` is an automation override.
It binds to loopback, and the normal renderer CSP stays unchanged. Aggregate MCP
and the Terminals add-on require the separate `agentAccess` control because they
grant local shell/subprocess access. Disabling Devbar stops both capabilities.
Do not add filesystem management, code-server, non-loopback binding, or remote
access without a new capability/security decision in the owning
[Spec](../../../../../specs/desktop-devbar.md) and
[Agent Note](../../../../../.agents/notes/implemented/feature/2026-09-16-devbar-hub-ui.md).
