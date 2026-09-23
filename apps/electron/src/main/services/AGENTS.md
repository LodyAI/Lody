# Main services

App icons are macOS packaged-app only. `app-icon-service.ts` owns device-local
preferences and the serialized native apply path; the renderer supplies only a
catalog identifier. Never edit signed resources or the shared development
Electron bundle. Finder custom metadata affects strict validation; see the
[icon decision](../../../../../.agents/notes/implemented/feature/2026-09-23-macos-app-icons.md).

Native notifications must stay strongly referenced after delivery succeeds, until
click, close, or failure. `NotificationService` owns those references and
`notification-delivery.ts` releases them; returning IPC success is not dismissal.
See the [lifetime fix](../../../../../.agents/notes/implemented/bug-fix/2026-09-20-notification-click-lifetime.md).

The Devbar Hub is off by default and starts only after the primary window's hidden
Developer Mode control enables it; `LODY_DEVBAR=true` is an automation override.
It binds to loopback, and the normal renderer CSP stays unchanged. Aggregate MCP
and the Terminals add-on require the separate `agentAccess` control because they
grant local shell/subprocess access. Disabling Devbar stops both capabilities.
Do not add filesystem management, code-server, non-loopback binding, or remote
access without a new capability/security decision in the owning
[Spec](../../../../../specs/desktop-devbar.md) and
[Agent Note](../../../../../.agents/notes/implemented/feature/2026-09-16-devbar-hub-ui.md).
